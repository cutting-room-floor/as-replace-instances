var _ = require('underscore');
var Step = require('step');
var util = require('util');
var S3 = require('./lib/s3');
var AWS = require('aws-sdk');
var env = {};

var config = module.exports;

// Allow override of the default superenv credentials
config.setCredentials = function (accessKeyId, secretAccessKey, bucket) {
    env.accessKeyId = accessKeyId;
    env.secretAccessKey = secretAccessKey;
    env.bucket = bucket;
};

config.replaceInstances = function(options, callback) {
    var region = options.region;
    var autoscaling = new AWS.AutoScaling(_(env).extend({
        region: region
    }));
    var s3 = new S3({
        awsKey: env.accessKeyId,
        awsSecret: env.secretAccessKey,
        bucket: env.bucket,
        prefix: 'deploy'
    });
    function run(callback) {
        var log = function() {
            var msg = util.format.apply(this, arguments);
            console.log('%s %s ' + msg, region, options.name);
        };
        var autoScalingGroup;
        var finalDoc;
        Step(function() {
            config.describeAutoScalingGroup(options.name, region, this);
        }, function(err, asGroup) {
            if (err) throw err;
            autoScalingGroup = asGroup;
            // Save initial MinSize and DesiredCapacity to doc in S3.
            // If doc already exists, use its values.
            s3.get('/' + region + '-' + autoScalingGroup.AutoScalingGroupName, function(err, res, doc) {
                if (err && err.code != 404) return this(err);
                if (!doc) {
                    finalDoc = {
                        DesiredCapacity: autoScalingGroup.DesiredCapacity,
                        MinSize: autoScalingGroup.MinSize
                    };
                    s3.put('/' + region + '-' + autoScalingGroup.AutoScalingGroupName, JSON.stringify(finalDoc), this);
                } else {
                    try { doc = JSON.parse(doc); }
                    catch (err) { return this(err); }
                    finalDoc = doc;
                    return this();
                }
            }.bind(this));
        }, function(err) {
            if (err) throw err;
            var stat = _(autoScalingGroup.instances).groupBy(function(i) {
                return i.Status;
            });
            // If sum of in-service and out-of-service instances is less than
            // original DesiredCapacity, increase the DesiredCapacity to reach
            // double the original DesiredCapacity.
            var newCount = _(stat.CurrentOutOfService).size() + _(stat.CurrentInService).size();
            if (newCount < finalDoc.DesiredCapacity) {
                var increase = finalDoc.DesiredCapacity - newCount;
                var newDesiredCapacity = parseInt(autoScalingGroup.DesiredCapacity) + increase;
                if (newDesiredCapacity > (finalDoc.DesiredCapacity * 2)) {
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
            } else if (_(stat.CurrentInService).size() < finalDoc.DesiredCapacity) {
                log('waiting for %s new instances to come InService', _(stat.CurrentOutOfService).size());
                this();
            // All new instances are in service, reduce MinSize
            } else if (autoScalingGroup.MinSize != finalDoc.MinSize) {
                log('reset MinSize to %s', finalDoc.MinSize);
                autoscaling.updateAutoScalingGroup({
                    AutoScalingGroupName: autoScalingGroup.AutoScalingGroupName,
                    MinSize: finalDoc.MinSize
                }, this);
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
            } else if (autoScalingGroup.DesiredCapacity != finalDoc.DesiredCapacity) {
                log('reset DesiredCapacity to %s', finalDoc.DesiredCapacity);
                autoscaling.updateAutoScalingGroup({
                    AutoScalingGroupName: autoScalingGroup.AutoScalingGroupName,
                    DesiredCapacity: finalDoc.DesiredCapacity
                }, this);
            } else {
                s3.del('/' + region + '-' + autoScalingGroup.AutoScalingGroupName, function(err) {
                    if (err) return this(err);
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
