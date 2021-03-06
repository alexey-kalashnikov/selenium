// Licensed to the Software Freedom Conservancy (SFC) under one
// or more contributor license agreements.  See the NOTICE file
// distributed with this work for additional information
// regarding copyright ownership.  The SFC licenses this file
// to you under the Apache License, Version 2.0 (the
// "License"); you may not use this file except in compliance
// with the License.  You may obtain a copy of the License at
//
//   http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing,
// software distributed under the License is distributed on an
// "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
// KIND, either express or implied.  See the License for the
// specific language governing permissions and limitations
// under the License.

/** @fileoverview Utilities for working with Firefox extensions. */

'use strict';

const fs = require('fs'),
    path = require('path'),
    xml = require('xml2js');

const io = require('../io');
const zip = require('../io/zip');


/**
 * Thrown when there an add-on is malformed.
 */
class AddonFormatError extends Error {
  /** @param {string} msg The error message. */
  constructor(msg) {
    super(msg);
    /** @override */
    this.name = this.constructor.name;
  }
}



/**
 * Installs an extension to the given directory.
 * @param {string} extension Path to the extension to install, as either a xpi
 *     file or a directory.
 * @param {string} dir Path to the directory to install the extension in.
 * @return {!Promise<string>} A promise for the add-on ID once
 *     installed.
 */
function install(extension, dir) {
  return getDetails(extension).then(function(details) {
    var dst = path.join(dir, details.id);
    if (extension.slice(-4) === '.xpi') {
      if (!details.unpack) {
        return io.copy(extension, dst + '.xpi').then(() => details.id);
      } else {
        return zip.unzip(extension, dst).then(() => details.id);
      }
    } else {
      return io.copyDir(extension, dst).then(() => details.id);
    }
  });
}


/**
 * Describes a Firefox add-on.
 * @typedef {{id: string, name: string, version: string, unpack: boolean}}
 */
var AddonDetails;

/** @typedef {{$: !Object<string, string>}} */
var RdfRoot;


/**
 * Extracts the details needed to install an add-on.
 * @param {string} addonPath Path to the extension directory.
 * @return {!Promise<!AddonDetails>} A promise for the add-on details.
 */
function getDetails(addonPath) {
  return io.stat(addonPath).then((stats) => {
    if (stats.isDirectory()) {
      return parseDirectory(addonPath);
    } else if (addonPath.slice(-4) === '.xpi') {
      return parseXpiFile(addonPath);
    } else {
      throw Error('Add-on path is not an xpi or a directory: ' + addonPath);
    }
  });

  /**
   * Parse an install.rdf for a Firefox add-on.
   * @param {string} rdf The contents of install.rdf for the add-on.
   * @return {!Promise<!AddonDetails>} A promise for the add-on details.
   */
  function parseInstallRdf(rdf) {
    return parseXml(rdf).then(function(doc) {
      var em = getNamespaceId(doc, 'http://www.mozilla.org/2004/em-rdf#');
      var rdf = getNamespaceId(
          doc, 'http://www.w3.org/1999/02/22-rdf-syntax-ns#');

      var description = doc[rdf + 'RDF'][rdf + 'Description'][0];
      var details = {
        id: getNodeText(description, em + 'id'),
        name: getNodeText(description, em + 'name'),
        version: getNodeText(description, em + 'version'),
        unpack: getNodeText(description, em + 'unpack') || false
      };

      if (typeof details.unpack === 'string') {
        details.unpack = details.unpack.toLowerCase() === 'true';
      }

      if (!details.id) {
        throw new AddonFormatError('Could not find add-on ID for ' + addonPath);
      }

      return details;
    });

    function parseXml(text) {
      return new Promise((resolve, reject) => {
        xml.parseString(text, (err, data) => {
          if (err) {
            reject(err);
          } else {
            resolve(data);
          }
        });
      });
    }

    function getNodeText(node, name) {
      return node[name] && node[name][0] || '';
    }

    function getNamespaceId(doc, url) {
      var keys = Object.keys(doc);
      if (keys.length !== 1) {
        throw new AddonFormatError('Malformed manifest for add-on ' + addonPath);
      }

      var namespaces = /** @type {!RdfRoot} */(doc[keys[0]]).$;
      var id = '';
      Object.keys(namespaces).some(function(ns) {
        if (namespaces[ns] !== url) {
          return false;
        }

        if (ns.indexOf(':') != -1) {
          id = ns.split(':')[1] + ':';
        }
        return true;
      });
      return id;
    }
  }

  /**
   * Parse a manifest for a Firefox WebExtension.
   * @param {{
   *   name: string,
   *   version: string,
   *   applications: {gecko:{id:string}}
   * }} json JSON representation of the manifest.
   * @return {!AddonDetails} The add-on details.
   */
  function parseManifestJson({name, version, applications}) {
    if (!(applications && applications.gecko && applications.gecko.id)) {
      throw new AddonFormatError('Could not find add-on ID for ' + addonPath);
    }

    return {id: applications.gecko.id, name, version, unpack: false};
  }

  function parseXpiFile(filePath) {
    return zip.load(filePath).then(archive => {
      if (archive.has('install.rdf')) {
        return archive.getFile('install.rdf')
            .then(buf => parseInstallRdf(buf.toString('utf8')));
      }

      if (archive.has('manifest.json')) {
        return archive.getFile('manifest.json')
            .then(buf => JSON.parse(buf.toString('utf8')))
            .then(parseManifestJson);
      }

      throw new AddonFormatError(
          `Couldn't find install.rdf or manifest.json in ${filePath}`);
    });
  }

  function parseDirectory(dirPath) {
    const rdfPath = path.join(dirPath, 'install.rdf');
    const jsonPath = path.join(dirPath, 'manifest.json');
    return io.exists(rdfPath)
        .then(rdfExists => {
          if (rdfExists) {
            return io.read(rdfPath)
                .then(buf => parseInstallRdf(buf.toString('utf8')));
          }
          return io.exists(jsonPath)
              .then(jsonExists => {
                if (jsonExists) {
                  return io.read(jsonPath)
                      .then(buf => JSON.parse(buf.toString('utf8')))
                      .then(parseManifestJson);
                }
                throw new AddonFormatError(
                    `Couldn't find install.rdf or manifest.json in ${dirPath}`);
              });
        })
  }
}


// PUBLIC API


exports.install = install;
