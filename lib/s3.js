var _ = require('underscore');
var knox = require('knox');

// Helper function to create Error objects from response statusCode.
var error = function(code) {
    var err = new Error(code);
    err.code = code;
    return err;
};

var S3 = module.exports = function(options) {
    this.prefix = options.prefix || '';
    this.client = knox.createClient({
        key: options.awsKey,
        secret: options.awsSecret,
        token: options.token,
        bucket: options.bucket
    });
    return this;
};

S3.prototype.put = function(id, object, cb) {
    var req = this.client.put(this.prefix + id, {
        'Content-Length': Buffer.byteLength(object, 'utf8'),
        'Content-Type': 'application/json',
        'x-amz-acl': 'public-read'
    });
    req.on('error', cb);
    req.on('response', function(res) {
        if (res.statusCode == 200) {
            cb(null);
        } else {
            cb(error(res.statusCode));
        }
    });
    req.end(object);
};

S3.prototype.update = function(id, object, cb) {
    this.get(id, function(err, original) {
        if (err && err.code != 404) return cb(err);
        object = _(original || {}).extend(object);
        this.put(id, object, cb);
    }.bind(this));
};

S3.prototype.get = function(id, cb) {
    var req = this.client.get(this.prefix + id);
    req.on('error', cb);
    req.on('response', function(res) {
        var body = '';
        res.setEncoding('utf8');
        res.on('data', function(chunk) {
            body += chunk;
        });
        res.on('end', function() {
            if (res.statusCode == 200) {
                cb(null, res, body);
            } else {
                cb(error(res.statusCode));
            }
        });
    });
    req.end();
};

S3.prototype.getRaw = function(key, cb) {
    var req = this.client.get(key);
    req.on('error', cb);
    req.on('response', function(res) {
        var body = '';
        res.setEncoding('utf8');
        res.on('data', function(chunk) {
            body += chunk;
        });
        res.on('end', function() {
            if (res.statusCode == 200) {
                cb(null, {
                    res: res,
                    body: body
                });
            } else {
                cb(error(res.statusCode));
            }
        });
    });
    req.end();
};

S3.prototype.del = function(id, cb) {
    var req = this.client.del(this.prefix + id);
    req.on('error', cb);
    req.on('response', function(res) {
        if (res.statusCode < 400) {
            cb();
        } else {
            cb(error(res.statusCode));
        }
    });
    req.end();
};

S3.prototype.copy = function(sourceBucket, sourceFilename, destFilename, cb) {
    sourceFilename = ensureLeadingSlash(sourceFilename);
    var headers = {
        'Expect': '100-continue',
        'x-amz-acl': 'public-read',
        'x-amz-copy-source': '/' + sourceBucket + sourceFilename,
        'Content-Length': 0 // to avoid Node's automatic chunking if omitted
    };
    var req = this.client.put(destFilename, headers);
    req.on('error', cb);
    req.on('response', function(res) {
        if (res.statusCode == 200) {
            cb(null);
        } else {
            cb(error(res.statusCode));
        }
    });
    req.end();
};

function ensureLeadingSlash(filename) {
    return filename[0] !== '/' ? '/' + filename : filename;
}
