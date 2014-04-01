#!/usr/bin/env node

var _ = require('underscore');
var config = require('..');
var env = require('superenv')('as');
var optimist = require('optimist');

config.setCredentials(env.accessKeyId, env.secretAccessKey, env.bucket);

var argv = optimist
    .options('region', {
        describe: 'AWS region where AutoScaling Group exists',
        demand: true,
        alias: 'r'
    })
    .options('name', {
        describe: 'Name of the AWS AutoScaling Group to cycle',
        demand: true,
        alias: 'n'
    })
    .argv;

if (argv.help) return optimist.showHelp();

config.replaceInstances(argv, function(err, result) {
    if (err) throw err;
    console.log(result ? 'Cycled instances on: ' + argv.name : '');
});
