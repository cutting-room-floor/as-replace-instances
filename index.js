var _ = require('underscore');
var Step = require('step');
var util = require('util');
var AWS = require('aws-sdk');
var env = {};

var config = module.exports;

// Allow override of the default superenv credentials
config.setCredentials = function (accessKeyId, secretAccessKey) {
    env.accessKeyId = accessKeyId;
    env.secretAccessKey = secretAccessKey;
};

config.replaceInstances = function(region, group, callback) {
    var autoscaling = new AWS.AutoScaling(_(env).extend({
        region: region
    }));
    function run() {
        var log = function() {
            var msg = util.format.apply(this, arguments);
            console.log('%s %s ' + msg, region, group);
        };
        var autoScalingGroup;
        var initialState;
        Step(function() {
            config.describeAutoScalingGroup(group, region, this);
        }, function(err, asGroup) {
            if (err) throw err;
            autoScalingGroup = asGroup;
            // Get saved initial state from ASG, if present
            initialState = _(autoScalingGroup.Tags).reduce(function(memo, tag) {
                if (tag.Key === 'ari:MinSize') {
                    memo.MinSize = tag.Value;
                    return memo;
                }
                else if (tag.Key === 'ari:DesiredCapacity') {
                    memo.DesiredCapacity = tag.Value;
                    return memo;
                } else {
                    return memo;
                }
            }, {});
            // Otherwise, get directly from ASG current values
            if (!initialState.MinSize || !initialState.DesiredCapacity) {
                initialState.MinSize = autoScalingGroup.MinSize;
                initialState.DesiredCapacity = autoScalingGroup.DesiredCapacity;
                // Save inital state as ASG tags
                autoscaling.createOrUpdateTags(asgTagParams(autoScalingGroup), this);
            } else {
                return this();
            }
        }, function(err) {
            if (err) throw err;
            var stat = _(autoScalingGroup.instances).groupBy(function(i) {
                return i.Status;
            });
            // If sum of in-service and out-of-service instances is less than
            // original DesiredCapacity, increase the DesiredCapacity to reach
            // double the original DesiredCapacity.
            var newCount = _(stat.CurrentOutOfService).size() + _(stat.CurrentInService).size();
            if (newCount < initialState.DesiredCapacity) {
                var increase = initialState.DesiredCapacity - newCount;
                var newDesiredCapacity = parseInt(autoScalingGroup.DesiredCapacity, 10) + increase;
                if (newDesiredCapacity > (initialState.DesiredCapacity * 2)) {
                    log('Refusing to increase Desired Capacity above target.');
                    log('Please review the AutoScaling Group\'s scaling activities for anomalies.');
                    this();
                } else {
                    log('setting MinSize and DesiredCapacity to %s', newDesiredCapacity);
                    autoscaling.updateAutoScalingGroup({
                        AutoScalingGroupName: autoScalingGroup.AutoScalingGroupName,
                        MinSize: newDesiredCapacity
                    }, this);
                }
            // Otherwise, DesiredCapacity is as it should be and must wait for
            // new instances to come into service.
            } else if (_(stat.CurrentInService).size() < initialState.DesiredCapacity) {
                log('waiting for %s new instances to come InService', _(stat.CurrentOutOfService).size());
                this();
            } else if (autoScalingGroup.MinSize != initialState.MinSize) {
                // Check for balanced AZ usage among new instances before
                // terminating obsolete instances
                var obsoleteAzs = _(stat.Obsolete).chain()
                  .pluck('AvailabilityZone').uniq().value();
                var newAzs = _(stat.CurrentInService).chain()
                  .pluck('AvailabilityZone').uniq().value();
                var balance = Math.floor(initialState.DesiredCapacity / autoScalingGroup.AvailabilityZones.length);
                var imbalance = false;
                // Check that new instances use same number of AZs as obsolete.
                if (newAzs.length < obsoleteAzs.length) {
                    imbalance = true;
                    log('New capacity uses fewer AZs than obsolete capacity. Waiting for rebalance to occur');
                }
                // Check for sufficient capacity in each AZ used by new instances
                _(newAzs).each(function(az) {
                    var count = _(stat.CurrentInService).reduce(function(memo, i) {
                        if (i.AvailabilityZone == az) return memo + 1;
                        else return memo;
                    }, 0);
                    var capacity = count / balance || 0;
                    if (capacity < 0.7) {
                        imbalance = true;
                        log(az + ' at ' + capacity + ' capacity. Waiting for rebalance to occur.');
                    }
                });
                if (imbalance) {
                    this();
                } else {
                    // All new instances are in service, AZs are within balance, reduce MinSize
                    log('reset MinSize to %s', initialState.MinSize);
                    autoscaling.updateAutoScalingGroup({
                        AutoScalingGroupName: autoScalingGroup.AutoScalingGroupName,
                        MinSize: initialState.MinSize
                    }, this);
                }
            // Terminate all old instances
            } else if (_(stat.Obsolete).size()) {
                log('terminating obsolete instances:\n ', _(stat.Obsolete).pluck('InstanceId').join('\n  '));
                var group = this.group();
                _(stat.Obsolete).each(function(i) {
                    autoscaling.terminateInstanceInAutoScalingGroup({
                        InstanceId: i.InstanceId,
                        ShouldDecrementDesiredCapacity: true
                    }, group());
                });
            } else if (_(stat.Terminating).size()) {
                log('waiting for obsolete instances to terminate');
                this();
            } else if (autoScalingGroup.DesiredCapacity != initialState.DesiredCapacity) {
                log('reset DesiredCapacity to %s', initialState.DesiredCapacity);
                autoscaling.updateAutoScalingGroup({
                    AutoScalingGroupName: autoScalingGroup.AutoScalingGroupName,
                    DesiredCapacity: initialState.DesiredCapacity
                }, this);
            } else {
                autoscaling.deleteTags(asgTagParams(autoScalingGroup), function(err) {
                    if (err) return err;
                    log('deploy complete');
                    this(null, true);
                }.bind(this));
            }
        }, function(err, done) {
            if (err) return callback(err);
            if (done === true) return callback();
            setTimeout(function() {
                run();
            }, 30000);
        });
    }
    run();
};

// Describe AutoscalingGroup including an ELB-aware instance health assessment.
config.describeAutoScalingGroup = function(groupId, region, callback) {
    var autoscaling = new AWS.AutoScaling(_(env).extend({
        region: region
    }));
    var elasticloadbalancing = new AWS.ELB(_(env).extend({
        region: region
    }));
    var launchConfigurationName;
    var instances;
    var autoScalingGroup;
    var elbs;
    Step(function() {
        autoscaling.describeAutoScalingGroups({
            AutoScalingGroupNames: [
                groupId,
            ],
        }, this);
    }, function(err, resp) {
        if (err) throw err;
        autoScalingGroup = _(resp.AutoScalingGroups).first();
        launchConfigurationName = autoScalingGroup.LaunchConfigurationName;
        instances = _([autoScalingGroup.Instances]).flatten();
        elbs = _([autoScalingGroup.LoadBalancerNames]).chain().flatten().compact().value();
        if (elbs.length) {
            var group = this.group();
            _(elbs).each(function(name) {
                elasticloadbalancing.describeInstanceHealth({
                    'LoadBalancerName': name
                }, group());
            });
        } else {
            this();
        }
    }, function(err, resp) {
        if (err) return callback(err);

        var inService = _(resp).chain()
            .pluck('InstanceStates')
            .flatten()
            .reduce(function(memo, i) {
                memo[i.InstanceId] = memo[i.InstanceId] || '';
                // Instance must in InService is both ELBs.
                if (memo[i.InstanceId] == 'OutOfService') return memo;
                memo[i.InstanceId] = i.State;
                return memo;
            }, {})
            .map(function(status, id) { if (status == 'InService') return id; })
            .compact()
            .value();

        autoScalingGroup.instances = _(instances).map(function(i) {
            if (_(['Terminating', 'Terminated']).contains(i.LifecycleState)) {
                i.Status = 'Terminating';
            } else if (i.LaunchConfigurationName !== launchConfigurationName) {
                i.Status = 'Obsolete';
            } else if (i.LaunchConfigurationName === launchConfigurationName) {
                if (_(inService).contains(i.InstanceId) || !_(elbs).size()) {
                    i.Status = 'CurrentInService';
                } else {
                    i.Status = 'CurrentOutOfService';
                }
            } else {
                i.Status = 'Unknown';
            }
            return i;
        });
        callback(null, autoScalingGroup);
    });
};

function asgTagParams(asg) {
    return {
        Tags: [
            {
                Key: 'ari:MinSize',
                PropagateAtLaunch: false,
                ResourceId: asg.AutoScalingGroupName,
                ResourceType: 'auto-scaling-group',
                Value: JSON.stringify(asg.MinSize),
            },
            {
                Key: 'ari:DesiredCapacity',
                PropagateAtLaunch: false,
                ResourceId: asg.AutoScalingGroupName,
                ResourceType: 'auto-scaling-group',
                Value: JSON.stringify(asg.DesiredCapacity),
            }
        ]
    };
}
