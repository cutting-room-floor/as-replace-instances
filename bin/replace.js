#!/usr/bin/env node

var _ = require('underscore');
var config = require('..');
var env = require('superenv')('as');
var optimist = require('optimist');

config.setCredentials(env.accessKeyId, env.secretAccessKey, env.bucket, env.prefix);

var argv = optimist
    .options('region', {
        describe: 'AWS region where AutoScaling Group exists',
        demand: true,
        alias: 'r'
    })
    .options('group', {
        describe: 'Name of the AWS AutoScaling Group to cycle',
        demand: true,
        alias: 'g'
    })
    .argv;

if (argv.help) return optimist.showHelp();

config.replaceInstances(argv.region, argv.group, function(err, result) {
    if (err) throw err;
    console.log('Cycled instances on %s', argv.group);
});
