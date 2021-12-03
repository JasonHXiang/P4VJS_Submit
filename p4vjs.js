"use strict";

// =============================
// PERFORCE INTERNAL ONLY
// UNSUPPORTED FOR EXTERNAL USE
//
// $Change: 2138183 $
// =============================

(function() {
  // Don't redefine p4vjs so that the one coming out of p4v is always preferred.
  if (window.p4vjs) {
    console.warn("As of P4V 21.1, manually including p4vjs.js is no longer necessary or recommended.");
    return;
  }

  var parameters = {};
  // %1

  // a UTF-8 safe btoa implementation
  function b64EncodeUnicode(str) {
    // first we use encodeURIComponent to get percent-encoded UTF-8,
    // then we convert the percent encodings into raw bytes which
    // can be fed into btoa.
    return btoa(encodeURIComponent(str)
      .replace(/%([0-9A-F]{2})/g,
        (match, p1) => String.fromCharCode('0x' + p1)
      ));
  }

  var isVersion2 = !!urlParameter("version");

  // Replaces special characters, so that the file can 
  // be used in a p4 command.
  var p4escape = function() {
    let p4Wildcards = {
      '#': "%23",
      '*': "%2A",
      '%': "%25",
      '@': "%40"
    };

    let p4WildcardRegex = /#|\*|%|@/g;

    return function(str) {
      if (!str || typeof str != "string")
        return str;

      return str.replace(p4WildcardRegex, (c) => {
        if (p4Wildcards.hasOwnProperty(c)) {
          return p4Wildcards[c];
        }
        return c;
      });
    };
  }();

  // Returns the value of an argument
  // The changelist to be submitted is passed in as a argument ?change=<changeNum>
  function urlParameter(sParam) {
    const url = new URL(window.location.href);
    const params = new URLSearchParams(url.search);
    // Prefer the injected parameters as they have a more reliable encoding.
    return parameters[sParam] || params.get(sParam);
  }

  // Takes a comma-delimited string and returns
  // an array of strings.
  // It expects commas to be encoded as \c and backlash to be \\
  // Example:
  // "a\cb,d,e\\f\c,g" => ["a,b", "d", "e\f,", "g"]
  function splitIntoStringList(files) {

    function decodeSplitString(str) {
      var isEscaping = false;
      var result = "";

      for (let i = 0; i < str.length; i++) {
        let c = str.charAt(i);
        if (isEscaping) {
          isEscaping = false;
          if (c === 'c') {
            result += ',';
          }
          else {
            result += c;
          }
        }
        else {
          if (c === '\\') {
            isEscaping = true;
          }
          else {
            result += c;
          }
        }
      }
      return result;
    }

    return files.split(',').map(decodeSplitString);
  }

  function baseURL() {
    var httpPort = urlParameter("httpport") || '8683';
    return "http://localhost:" + httpPort;
  }

  // ------------------------------
  // PRIVATE API
  // ------------------------------

  // Run a command against the P4HTTP server.
  // The 'args' parameter is optional
  // Returns a Promise to a Response object
  async function run(command, args) {
    var httpPort = urlParameter("httpport") || '8683';
    var params = {
      arguments: args || {},
      scopename: urlParameter("scopename")
    }
    var url = "http://127.0.0.1:" + httpPort + "/p4v/" + command + "?" +
      encodeURI(JSON.stringify(params));

    return fetch(url) // catch and print all errors by default
      .catch((err) => {
        console.error("Failed!\n", err);
      });
  }

  // Like run(), but returns a Promise to a string
  async function runText(command, args) {
    var response = await run(command, args);
    return response.text();
  }

  // Like run(), but returns a Promise to a JSON-compliant object
  async function runJSON(command, args) {
    var response = await run(command, args);
    return response.json();
  }

  // Generates simple functions that query the server for a property.
  //
  // The result of this function is *another function*. You call it,
  // it "writes" the resulting function for you, and returns it.
  //
  function prop(name) {
    return async function() {
      if (isVersion2) {
        return (await cppP4VJS).prop(name);
      }

      return runText("prop", {
        key: name
      });
    }
  }

  var privateURLParameters = [
    "scopename",
    "windowid",
    "httpport",
    "files",
    "file",
    "directories",
    "p4vtheme",
    "version"
  ];

  // The callbacks are indexed by whatever ID we get from the Javascript side.
  // This could be a simple number (which is efficient) so we use
  // a Map to index it.
  var callbacks = new Map();

  // This provides an abstraction around the callback mechanism. All native p4vjs::Api
  // asynchronous functions have this parameter list:
  //     void asyncFunction(id, ...the-rest-of-the-args)
  // Let's look at the p4() call. It looks like this:
  //     void p4(id, command, form);
  // Consumers of the p4vjs api aren't going to know about the ID parameter, they
  // want to call p4(command, form). So our javascript implementation of
  // p4(command, form) needs to do this:
  // 1. get a unique invocation ID
  // 2. make a Promise that will deliver the result, and register its resolve
  //    function into the callback table with the unique ID
  // 3. call the p4() call but insert the invocation ID as the first parameter
  // 4. Return the Promise which will deliver the final result.
  //
  // To make this easier, we can use this callAsync() abstraction to make it work.
  // Continuing with the p4 example, if we want our, public p4(command, form) call to
  // be turned into the native call: p4(id, command, form), then we need to call this:
  // callAsync((await cppP4VJS).p4, command, form)
  //
  async function callAsync(func, ...args) {
    let api = await cppP4VJS;
    let id = await api.nextInvocationID();

    return new Promise((resolve) => {
      callbacks.set(id, resolve);
      func(id, ...args);
    });
  }

  // This is called whenever cppP4VJS emits that it has finished with an
  // async operation. It supplies us with the id and the result.
  // We use the id to look up a registered callback, and if found, pass
  // it the result.
  function callbackDispatcher(id, result) {
    let callback = callbacks.get(id);
    if (typeof(callback) !== "undefined") {
      callbacks.delete(id);
      callback(result);
    }
  };

  let cppP4VJS = new Promise(async (resolve) => {
    if (!isVersion2) {
      resolve(null);
      return;
    }

    // We use setTimeout() because depending on the order that QT injects
    // qwebchannel.js into the page, it may not be loaded yet so before
    // attempting to use it, we wait one iteration through the event-loop.
    // The result is that this only runs after the browser has parsed through
    // all the injected scripts.
    setTimeout(async () => {
      let api = await P4VObjectInjection.injectedObject("p4vjs");

      // In order to receive asynchronous callbacks from p4vjs, we need to
      // connect to the general-purpose callback signal: asyncCallCompleted.
      // The callback we register will use the emitted ID to look up in our callback
      // table to see if there is a registered callback when we call it.
      api.asyncCallCompleted.connect(callbackDispatcher);
      resolve(api);
    }, 0);
  });

  // ------------------------------
  // PUBLIC API
  // ------------------------------

  window.p4vjs = {
    ObjectType: Object.freeze({
      BRANCH: 'Branch',
      PENDINGCHANGE: 'Pending',
      SUBMITTEDCHANGE: 'Submitted',
      CLIENT: 'Client',
      GROUP: 'Group',
      JOB: 'Job',
      LABEL: 'Label',
      STREAM: 'Stream',
      USER: 'User',
      REPO: 'Repo'
    }),

    MapSide: Object.freeze({
      NEITHER: 'Neither',
      LEFT: 'Left',
      RIGHT: 'Right',
      BOTH: 'Both'
    }),

    // ---------------
    // Api Version 2.0
    // ---------------
    /**
     * p4vjs.closeWindow()
     **/
    closeWindow: async function() {
      if (isVersion2) {
        (await cppP4VJS).closeWindow();
        return;
      }

      var JSWindowId = urlParameter("windowid");
      if (JSWindowId) {
        v1Engine.run('GET', "close", {
          windowid: JSWindowId
        });
      }
    },

    /**
     * p4vjs.p4(command, form, callback)
     * 
     * executes the HTTP request executing p4 requests
     **/
    p4: async function(command, form, callback) {
      let returnValue = await (async function() {
        if (isVersion2) {
          if (typeof command === "string") {
            console.warn("Passing a command string to p4vjs.p4() is deprecated. Instead pass an array of string arguments. For example: change p4vjs.p4(\"fstat file\") to p4vjs.p4([\"fstat\", \"file\"])");
          }
          else if (!Array.isArray(command)) {
            console.error("The command parameter to p4() should be an array of strings.");
            return null;
          }
          return callAsync((await cppP4VJS).asyncP4, command, form);
        }

        if (typeof command !== "string") {
          console.warn("p4vjs.p4() can only take a command string when talking to p4v < v2021.1");
        }

        return runJSON("p4", {
          command: b64EncodeUnicode(command),
          form: b64EncodeUnicode(JSON.stringify(form || {}))
        });
      }());

      // Preserve backward compatibility by calling the explicit
      // callback (if there is one).
      if (callback) {
        callback(returnValue);
      }

      return returnValue;
    },

    /**
     * p4vjs.getApiVersion()
     **/
    getApiVersion: prop("apiversion"),

    /** 
     * p4vjs.getCharset()
     **/
    getCharset: prop("charset"),

    /**
     * p4vjs.getClient()
     **/
    getClient: prop("client"),

    /** 
     * p4vjs.getPort()
     **/
    getPort: prop("port"),

    /**
     * p4vjs.getUser()
     **/
    getUser: prop("user"),

    /**
     * p4vjs.getServerRootDirectory()
     **/
    getServerRootDirectory: prop("serverroot"),

    /**
     * p4vjs.getServerVersion()
     **/
    getServerVersion: prop("serverversion"),

    /**
     * p4vjs.isServerUnicode()
     **/
    isServerUnicode: prop("unicode"),
    isServerCaseSensitive: prop("casesensitive"),
    getServerSecurityLevel: prop("securitylevel"),

    /**
     * p4vjs.getImageNames() 
     *
     * returns the names of the Perforce built-in images
     **/
    getImageNames: async function() {
      if (isVersion2) {
        return (await cppP4VJS).getImageNames();
      }

      return runJSON("imgnames");
    },

    /** 
     * p4vjs.getImage(name) 
     *
     * returns the image matching the built-in image name
     **/
    getImage: async function(name) {
      if (isVersion2) {
        return (await cppP4VJS).getImage(name);
      }

      return runText("image", {
        name: name
      });
    },

    /** 
     * p4vjs.getSelection()
     *
     * returns the selected depot paths
     **/
    getSelection: async function() {
      if (isVersion2) {
        return (await cppP4VJS).getSelectionAsString();
      }

      return runText("selected");
    },

    /** 
     * p4vjs.setSelection([path, ...]) 
     *
     * send selection of depot paths
     **/
    setSelection: async function(paths) {
      if (isVersion2) {
        return (await cppP4VJS).setSelection(paths);
      }

      var response = await runText("select", {
        paths: b64EncodeUnicode(paths)
      });
      return (response === "true");
    },

    /** 
     * p4vjs.refreshAll() 
     **/
    refreshAll: async function() {
      if (isVersion2) {
        return (await cppP4VJS).refreshAll();
      }

      return runText("refreshall");
    },

    /** 
     * p4vjs.openUrlInBrowser(url)
     **/
    openUrlInBrowser: async function(myurl) {
      if (isVersion2) {
        return (await cppP4VJS).openUrlInBrowser(myurl);
      }
      var response = await runText("openurl", {
        url: b64EncodeUnicode(myurl)
      });
      return (response === "true");
    },

    /** 
     * p4vjs.setP4VErrorDialogEnabled(enable) 
     **/
    setP4VErrorDialogEnabled: async function(enable) {
      if (isVersion2) {
        return (await cppP4VJS).setP4VErrorDialogEnabled(enable);
      }
      var response = await runText("errorenable", {
        enable: enable
      });
      return (response === "true");
    },

    /** 
     * var darktheme = p4vjs.useDarkTheme()
     *
     * returns true if p4v uses dark theme to display
     **/
    useDarkTheme: function() {
      return urlParameter("p4vtheme") === "dark";
    },

    // ---------------
    // Api Version 3.0
    // ---------------

    /** 
     * p4vjs.nextPage()
     *
     * switches from pre-page window in HTML Action, to P4V implementation
     **/
    nextPage: async function() {
      if (isVersion2) {
        return (await cppP4VJS).nextPage();
      }
      else {
        var JSWindowId = urlParameter("windowid");
        if (JSWindowId) {
          v1Engine.run('GET', "next", {
            windowid: JSWindowId
          });
        }
      }
    },

    // ---------------
    // Api Version 3.1
    // ---------------

    /** 
     * p4vjs.selectedFiles()
     *
     * returns an array containing the selected files
     **/
    selectedFiles: function() {
      var files = urlParameter("files");
      if (typeof files === "string") {
        return splitIntoStringList(files).map(p4escape);
      }
      return [];
    },

    /** 
     * p4vjs.selectedFile()
     *
     * returns the first selected file
     **/
    selectedFile: function() {
      var file = urlParameter("file");
      return p4escape(file);
    },

    /** 
     * p4vjs.selectedDirectories()
     *
     * returns an array containing the selected directories
     **/
    selectedDirectories: function() {
      var dirs = urlParameter("directories");
      if (typeof dirs === "string") {
        return splitIntoStringList(dirs).map(p4escape);
      }
      return [];
    },

    /**
     * p4vjs.getParameter()
     **/
    getParameter: function(name) {
      if (name == "files") {
        console.log("Retrieving the 'files' variable is deprecated. Use selectedFiles() instead.");
        return this.selectedFiles();
      }

      if (name == "file") {
        console.log("Retrieving the 'file' variable is deprecated. Use selectedFile() instead.");
        return this.selectedFile();
      }

      if (name == "directories") {
        console.log("Retrieving the 'directories' variable is deprecated. Use selectedDirectories() instead.");
        return this.selectedDirectories();
      }

      if (privateURLParameters.includes(name)) {
        return null;
      }
      return urlParameter(name);
    },

    /**
     * p4vjs.GetURLParameter()
     **/
    GetURLParameter: function(name) {
      console.log("The p4vjs.GetUrlParameter() call is deprecated. Please use: p4vjs.getParameter(...).");
      return this.getParameter(name);
    },

    // ---------------
    // Api Version 3.2
    // ---------------

    /**
     * p4vjs.refresh(objecttype, name)
     * 
     * refreshes the object requested.
     **/
    refresh: async function(objecttype, name) {
      if (!Object.values(p4vjs.ObjectType).includes(objecttype)) {
        throw `"${objecttype}" is not recognized as a valid p4vjs.ObjectType value`;
      }

      if (isVersion2) {
        return callAsync((await cppP4VJS).asyncRefresh, objecttype, name);
      }

      var response = await runText("refresh", {
        type: objecttype,
        name: name
      });
      return (response === "true");
    },

    /** 
     * p4vjs.refreshFiles([path, ...]) 
     *
     * send selection of depot paths
     **/
    refreshFiles: async function(paths) {
      if (isVersion2) {
        return (await cppP4VJS).refreshFiles(paths);
      }

      var response = await runText("refreshfiles", {
        paths: paths
      });
      return (response === "true");
    },

    mapIncludes: async function(p4map, p4path) {
      if (!isVersion2) {
        throw 'mapIncludes is only available with version 3.2. Use p4vjs.getApiVersion()';
      }
      return (await cppP4VJS).mapIncludes(p4map, p4path);
    },

    mapTranslate: async function(p4map, p4path, mapside) {
      if (!isVersion2) {
        throw 'mapTranslate is only available with version 3.2. Use p4vjs.getApiVersion()';
      }
      if (!Object.values(p4vjs.MapSide).includes(mapside)) {
        throw `"${mapside}" is not recognized as a valid p4vjs.MapSide value`;
      }
      return (await cppP4VJS).mapTranslate(p4map, p4path, mapside);
    },

    mapCount: async function(p4map) {
      if (!isVersion2) {
        throw 'mapCount is only available with version 3.2. Use p4vjs.getApiVersion()';
      }
      return (await cppP4VJS).mapCount(p4map);
    },

    mapJoin: async function(p4map1, p4map2) {
      if (!isVersion2) {
        throw 'mapJoin is only available with version 3.2. Use p4vjs.getApiVersion()';
      }
      return (await cppP4VJS).mapJoin(p4map1, p4map2);
    },

    mapReverse: async function(p4map) {
      if (!isVersion2) {
        throw 'mapReverse is only available with version 3.2. Use p4vjs.getApiVersion()';
      }
      return (await cppP4VJS).mapReverse(p4map);
    },

    mapRight: async function(p4map) {
      if (!isVersion2) {
        throw 'mapRight is only available with version 3.2. Use p4vjs.getApiVersion()';
      }
      return (await cppP4VJS).mapRight(p4map);
    },

    mapLeft: async function(p4map) {
      if (!isVersion2) {
        throw 'mapLeft is only available with version 3.2. Use p4vjs.getApiVersion()';
      }
      return (await cppP4VJS).mapLeft(p4map);
    }
  };

  // For backward compatibility
  window.GetURLParameter = function(sParam) {
    console.log("The global GetUrlParameter() call is deprecated. Please use: p4vjs.getParameter(...).");
    return p4vjs.getParameter(sParam);
  };
}());