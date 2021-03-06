var path = require("path");
var fs = require("fs");
var Module = require("module");

var outputDir = process.argv[2];
var projectRoot = process.argv[3];
var stdin = process.stdin;

if (process.env["FASTPACK_PARENT_PID"]) {
  const parentPid = Number(process.env["FASTPACK_PARENT_PID"]);

  if (typeof parentPid === "number" && !isNaN(parentPid)) {
    setInterval(function() {
      try {
        process.kill(parentPid, 0); // throws an exception if the main process doesn't exist anymore.
      } catch (e) {
        process.exit();
      }
    }, 200);
  }
}

module.paths = process
  .cwd()
  // collect self and parents
  .split(path.sep)
  .map((_, index, array) => array.slice(0, index + 1))
  // append node_modules to each path
  .map(chunks => [...chunks, "node_modules"].join(path.sep))
  // sort from the deepest to the root
  .reverse()
  // exclude paths outside of project root
  .filter(item => item.includes(projectRoot))
  .concat(module.paths);

var fromFile = path.join(process.cwd(), "noop.js");
function resolve(request) {
  return Module._resolveFilename(request, {
    id: fromFile,
    filename: fromFile,
    paths: module.paths
  });
}

function handleError(e) {
  var message = (e.message || e + "");
  var name = e.name || "UnknownError";
  var stack = e.stack || null;
  return { name: name, message: message, stack: stack };
}

function extractSource(result) {
  if (result instanceof Array) {
    return extractSource(result[0]);
  } else if (result instanceof Buffer) {
    return Buffer.from(result, "utf-8");
  } else if (typeof result === "string") {
    return result;
  } else {
    return null;
  }
}

function load(message) {
  var ret = {
    files: [],
    dependencies: [],
    warnings: [],
    source: null,
    error: null
  };
  try {
    var message = JSON.parse(message);
  } catch (e) {
    ret.error = handleError(e);
    write(ret);
    return;
  }

  var rootContext = message.rootContext || null;
  var loaders = message.loaders || [];
  var filename = message.filename || null;
  var source = message.source || null;

  try {
    if (!rootContext) {
      throw "rootContext is not provided";
    }

    var files = [];
    var runner = require("loader-runner");
    runner.runLoaders(
      {
        resource: filename,
        loaders: loaders,
        context: {
          _compiler: {
            plugin: function() {}
          },
          _module: {
            errors: [],
            meta: {}
          },
          rootContext: rootContext,
          fs: fs,
          emitWarning: function(error) {
            ret.warnings.push(error.message || error + "");
          },
          emitError: function(error) {
            ret.error = handleError(error);
          },
          loadModule: function(request, callback) {
            callback(
              "Fastpack cannot load modules from Webpack loaders: " + request,
              null
            );
          },
          resolve: function(context, request, callback) {
            if (context === "") {
              context = ".";
            }
            if (request[0] === ".") {
              request = path.join(context, request);
              if (request[0] !== "/") request = "./" + request;
            }

            try {
              callback(null, resolve(request));
            } catch (e) {
              callback(e, null);
            }
          },
          options: {},
          emitFile: function(name, buffer) {
            files.push({
              name: name,
              content: buffer
            });
          }
        },
        readResource: function(path, callback) {
          if (path === filename && source) {
            callback(null, Buffer.from(source, "utf-8"));
          } else {
            return fs.readFile(path, callback);
          }
        }
      },
      function(error, result) {
        if (ret.error) {
          // error emitted in emitError
        } else if (error) {
          ret.error = handleError(error);
        } else if (result.result instanceof Array) {
          ret.source = extractSource(result.result);
          if (ret.source !== null) {
            ret.dependencies = [].concat(
              result.fileDependencies || [],
              result.contextDependencies || []
            );
          } else {
            ret.error = {
              name: "UnexpectedResult",
              message:
                "Cannot extract result from loader. " +
                "Expected results: Array of String, Buffer, String"
            };
          }
        }
        for (var i = 0, l = files.length; i < l; i++) {
          var absPath = path.join(outputDir, files[i].name);
          writeFile(absPath, files[i].content);
          ret.files.push(absPath);
        }
        write(ret);
      }
    );
  } catch (e) {
    ret.error = handleError(e);
    write(ret);
  }
}

var rest = "";

var writeOrig = process.stdout.write.bind(process.stdout);
process.stdout.write = function() {};
process.stderr.write = function() {};
function write(obj) {
  var message = JSON.stringify(obj);
  writeOrig(message + "\n");
}

function makeDirs(dir) {
  if (fs.existsSync(dir)) {
    return;
  }
  makeDirs(path.dirname(dir));
  fs.mkdirSync(dir);
}

function writeFile(absPath, content) {
  if (absPath.substr(0, outputDir.length) !== outputDir) {
    throw {
      name: "FileWriteError",
      message: "Path is out of the output directory: " + absPath
    };
  }
  makeDirs(path.dirname(absPath));
  fs.writeFileSync(absPath, content);
}

stdin.resume();
stdin.setEncoding("utf8");

stdin.on("data", function(data) {
  var nl = data.indexOf("\n");
  if (nl === -1) {
    rest += data;
  } else {
    var message = rest + data.slice(0, nl);
    rest = data.slice(nl + 1);
    load(message);
  }
});

// require('net').createServer().listen();
