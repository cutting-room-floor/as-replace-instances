Safely replace all instances in AWS AutoScaling Group.

## How it works

- Doubles MinSize and DesiredCapacity of target AutoScaling Group
- Waits for new instances to become healthy in all AutoScaling Group's ELBs
- Terminates obsolete instances
- Returns MinSize and DesiredCapacity to their original values

## Installation

Install globally with `npm` to use CLI commands:

```
$ npm install -g as-replace-instances
```

or use its javascript API in your own project.

### Configuration

Place the following inside a file called ~/.asrc

```plain
{
    "accessKeyId": "AWS_ACCESS_KEY_ID",
    "secretAccessKey": "AWS_SECRET_ACCESS_KEY"
}
```

## Usage

Provides single CLI command: `as-replace-instances`, used like

`as-replace-instances` -r `<region>` -n `<autoscaling-group>`

- -r is the AWS region within which the specified AutoScaling Group exists
- -n is the name of the AutoScaling Group on which to act

or to use its javascript library:

> var as = require('as-replace-instances');
