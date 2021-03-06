'use strict';

function _interopDefault (ex) { return (ex && (typeof ex === 'object') && 'default' in ex) ? ex['default'] : ex; }

var fs = require('fs');
var readData = _interopDefault(require('data-uri-to-buffer'));
var mimeTypes = _interopDefault(require('mime-types'));
var fetch = _interopDefault(require('make-fetch-happen'));
var babel = _interopDefault(require('@babel/core'));

function isRelativeURL(value) {
  return value.charAt(0) === '.' || value.charAt(0) === '/';
}

function rewriteValue(node, base) {
  if (isRelativeURL(node.value)) {
    const absoluteURL = new URL(node.value, base);
    node.value = absoluteURL.href;
  }
}

function relativeRewrite(base) {
  return {
    manipulateOptions(opts, parserOpts) {
      parserOpts.plugins.push(
        'dynamicImport',
        'exportDefaultFrom',
        'exportNamespaceFrom',
        'importMeta'
      );
    },

    visitor: {
      CallExpression(path) {
        if (path.node.callee.type !== 'Import') {
          // Some other function call, not import();
          return;
        }

        if (path.node.arguments[0].type !== 'StringLiteral') {
          // Non-string argument, probably a variable or expression, e.g.
          // import(moduleId)
          // import('./' + moduleName)
          return;
        }

        rewriteValue(path.node.arguments[0], base);
      },
      ExportAllDeclaration(path) {
        rewriteValue(path.node.source, base);
      },
      ExportNamedDeclaration(path) {
        if (!path.node.source) {
          // This export has no "source", so it's probably
          // a local variable or function, e.g.
          // export { varName }
          // export const constName = ...
          // export function funcName() {}
          return;
        }

        rewriteValue(path.node.source, base);
      },
      ImportDeclaration(path) {
        rewriteValue(path.node.source, base);
      }
    }
  };
}

function rewriteRelativeJavaScriptImports(base, code) {
  const options = {
    // Ignore .babelrc and package.json babel config
    // because we haven't installed dependencies so
    // we can't load plugins; see #84
    babelrc: false,
    // Make a reasonable attempt to preserve whitespace
    // from the original file. This ensures minified
    // .mjs stays minified; see #149
    retainLines: true,
    plugins: [relativeRewrite(base)]
  };

  return babel.transform(code, options).code;
}

function rewriteRelativeImports(base, contentType, code) {
  switch (contentType) {
    case 'application/javascript':
      return rewriteRelativeJavaScriptImports(base, code);
    default:
      return code;
  }
}

function parseURL(source) {
  try {
    return new URL(source);
  } catch (error) {
    // Not a valid absolute-URL-with-fragment string
    // https://url.spec.whatwg.org/#absolute-url-with-fragment-string
    return null;
  }
}

function isValidURL(url) {
  if (url && ['data:', 'file:', 'http:', 'https:'].includes(url.protocol)) {
    return true;
  }
  return false;
}

function resolveURL(url) {
  return url.href;
}

async function loadURL(url, fetchOpts) {
  // console.log('load', url.href);

  switch (url.protocol) {
    case 'data:':
      // TODO: Resolve relative imports in data URIs?
      return readData(url.href);
    case 'file:':
      return rewriteRelativeImports(
        url,
        mimeTypes.lookup(url.href),
        fs.readFileSync(url).toString()
      );
    case 'http:':
    case 'https:':
      return fetch(url.href, fetchOpts).then(res =>
        res.status === 404
          ? null
          : res.text().then(text => {
              // Resolve relative to the final URL, i.e. how browsers do it.
              const finalURL = new URL(res.url);
              const contentTypeHeader = res.headers.get('Content-Type');
              const contentType = contentTypeHeader
                ? contentTypeHeader.split(';')[0]
                : 'text/plain';

              return rewriteRelativeImports(finalURL, contentType, text);
            })
      );
  }
}

function urlResolve(fetchOpts) {
  return {
    resolveId(source) {
      const url = parseURL(source);
      return isValidURL(url) ? resolveURL(url) : null;
    },
    load(id) {
      const url = parseURL(id);
      return isValidURL(url) ? loadURL(url, fetchOpts) : null;
    }
  };
}

module.exports = urlResolve;
