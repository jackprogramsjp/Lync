/*
	Lync Server
	https://github.com/Iron-Stag-Games/Lync
	Copyright (C) 2022  Iron Stag Games

	This library is free software; you can redistribute it and/or
	modify it under the terms of the GNU Lesser General Public
	License as published by the Free Software Foundation; either
	version 2.1 of the License, or (at your option) any later version.

	This library is distributed in the hope that it will be useful,
	but WITHOUT ANY WARRANTY; without even the implied warranty of
	MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
	Lesser General Public License for more details.

	You should have received a copy of the GNU Lesser General Public
	License along with this library; if not, write to the Free Software
	Foundation, Inc., 51 Franklin Street, Fifth Floor, Boston, MA  02110-1301
	USA
*/
const VERSION = 'Alpha 24'

const { spawn, spawnSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const process = require('process')

const chokidar = require('chokidar')
const { parseCSV } = require('csv-load-sync')
const extract = require('extract-zip')
const { http, https } = require('follow-redirects')
const LUA = require('lua-json')
const picomatch = require('picomatch')
const XLSX = require('xlsx')

const { red, yellow, green, cyan, fileError, fileWarning } = require('./output.js')
const { generateSourcemap } = require('./sourcemap/sourcemap.js')
const { validateJson, validateYaml, validateToml } = require('./validator/validator.js')

if (!process.pkg) process.exit()

const PLATFORM = process.platform == 'win32' && 'windows' || process.platform == 'darwin' && 'macos' || 'linux'
const UTF8 = new TextDecoder('utf-8')
const LYNC_INSTALL_DIR = path.dirname(process.execPath)
const CONFIG_PATH = path.resolve(LYNC_INSTALL_DIR, 'lync-config.json')
let CONFIG;
try {
	CONFIG = {
		"Debug": false,
		"GenerateSourcemap": true,
		"AutoUpdate": false,
		"GithubUpdateRepo": "Iron-Stag-Games/Lync",
		"GithubUpdatePrereleases": false,
		"LatestId": 0,
		"RobloxVersionsPath": "",
		"RobloxContentPath": "",
		"RobloxPluginsPath": "",
		"StudioModManagerContentPath": "",
		"LunePath": "lune"
	}
	if (PLATFORM == 'windows') {
		CONFIG.RobloxVersionsPath = "%LOCALAPPDATA%/Roblox/Versions"
		CONFIG.RobloxPluginsPath = "%LOCALAPPDATA%/Roblox/Plugins"
		CONFIG.StudioModManagerContentPath = "%LOCALAPPDATA%/Roblox Studio/content"
		delete CONFIG.RobloxContentPath
	} else if (PLATFORM == 'macos') {
		CONFIG.RobloxContentPath = "/Applications/RobloxStudio.app/Contents/Resources/content"
		CONFIG.RobloxPluginsPath = "$HOME/Documents/Roblox/Plugins"
		delete CONFIG.RobloxVersionsPath
		delete CONFIG.StudioModManagerContentPath
	} else {
		delete CONFIG.RobloxVersionsPath
		delete CONFIG.RobloxContentPath
		delete CONFIG.RobloxPluginsPath
		delete CONFIG.StudioModManagerContentPath
	}
	if (fs.existsSync(CONFIG_PATH)) {
		const oldConfig = JSON.parse(fs.readFileSync(CONFIG_PATH))
		for (const key in oldConfig)
			if (key in CONFIG)
				CONFIG[key] = oldConfig[key]
	}
	fs.writeFileSync(CONFIG_PATH, JSON.stringify(CONFIG, null, '\t'))
} catch (err) {
	console.error(red(err))
	process.exit(-1)
}
const DEBUG = CONFIG.Debug

// Args
/**
 * @param {any} err 
 * @returns {never}
 */
function argHelp(err) {
	if (err) console.error(red('Argument error:'), yellow(err) + '\n')
	console.log(`┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
┃ LYNC HELP                          Displays the list of available arguments.          ┃ 
┃      SERVE ${cyan('project.json', true)}? ${green('REMOTE', true)}?   Syncs the project.                                 ┃
┃      OPEN  ${cyan('project.json', true)}? ${green('REMOTE', true)}?   Syncs the project and opens it in Roblox Studio.   ┃
┃      BUILD ${cyan('project.json', true)}?           Builds the project to file.                        ┃
┃      FETCH ${cyan('project.json', true)}?           Downloads the list of sources in the project file. ┃
┣╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍╍┫
┃ ${cyan('project.json', true)}?   The project file to read from and serve.                              ┃
┃ ${green('REMOTE', true)}?         Connect to the project's ${green('remoteAddress')} instead of the localhost.    ┃
┃                 ${red('Warning:')} ${yellow('REMOTE is unimplemented!')}                                     ┃
┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛ 
`)
	process.exit(err && -1 || 0)
}
const ARGS = process.argv.slice(2)
if (ARGS.length == 0 || ARGS[0].toLowerCase() == 'help') argHelp()
const MODE = ARGS[0].toLowerCase()
if (MODE != 'serve' && MODE != 'open' && MODE != 'build' && MODE != 'fetch') argHelp('Mode must be SERVE, OPEN, BUILD, or FETCH')
if (MODE == 'open' && PLATFORM != 'windows' && PLATFORM != 'macos') argHelp('Cannot use OPEN mode on Linux')
const PROJECT_JSON = ARGS[1] && ARGS[1].replace(/\\/g, '/') || 'default.project.json'
const USE_REMOTE = ARGS[2] && ARGS[2].toLowerCase() == 'remote' // Unimplemented

var securityKeys = {}
var map = {}
var mTimes = {}
var modified = {}
var modified_playtest = {}
var modified_sourcemap = {}
var projectJson;
var globIgnorePaths;
var globIgnorePathsPicoMatch;
var hardLinkPaths;


// Common Functions

/**
 * @param {string} localPath 
 * @returns {boolean}
 */
function localPathExtensionIsMappable(localPath) {
	const localPathExt = path.parse(localPath).ext.toLowerCase()
	return localPathExt == '.rbxm' || localPathExt == '.rbxmx' || localPathExt == '.lua' || localPathExt == '.luau' || localPathExt == '.json' || localPathExt == '.yaml' || localPathExt == '.toml' || localPathExt == '.txt' || localPathExt == '.csv'
}

/**
 * @param {string} localPath 
 * @returns {boolean}
 */
function localPathIsInit(localPath) {
	const localPathParsed = path.parse(localPath)
	const localPathName = localPathParsed.name.toLowerCase()
	const localPathExt = localPathParsed.ext.toLowerCase()
	return (localPathExt == '.lua' || localPathExt == '.luau') && (localPathName == 'init' || localPathName == 'init.client' || localPathName == 'init.server' || localPathName.endsWith('.init') || localPathName.endsWith('.init.client') || localPathName.endsWith('.init.server'))
}

function localPathIsIgnored(localPath) {
	localPath = path.relative(path.resolve(), localPath)
	return globIgnorePathsPicoMatch(localPath.replace(/\\/g, '/'))
}


// Mapping Functions

/**
 * @param {string} robloxPath 
 * @param {any} mapDetails 
 * @param {number} mtimeMs 
 */
function assignMap(robloxPath, mapDetails, mtimeMs) {
	if (mapDetails.Path != undefined) {
		let localPath = mapDetails.Path
		if (typeof localPath == 'object') {
			localPath = localPath.optional
		}
		if (localPathIsIgnored(localPath)) return
	}
	if (DEBUG) console.log('Mapping', mapDetails.Type, green(robloxPath), '->', cyan(mapDetails.Path || ''))
	if (robloxPath in map) {
		if (map[robloxPath].Path != mapDetails.Path && !map[robloxPath].ProjectJson) {
			console.warn(yellow(`Collision on '${robloxPath}'`))
			if (DEBUG) console.warn(map[robloxPath], '->', mapDetails)
		}
		if (map[robloxPath].ProjectJson) {
			mapDetails.ProjectJson = map[robloxPath].ProjectJson
		}
	}
	map[robloxPath] = mapDetails
	modified[robloxPath] = mapDetails
	modified_playtest[robloxPath] = mapDetails
	modified_sourcemap[robloxPath] = mapDetails
	if (mapDetails.Path) mTimes[mapDetails.Path] = mtimeMs
	if (mapDetails.Meta) mTimes[mapDetails.Meta] = fs.statSync(mapDetails.Meta).mtimeMs // Meta File stats are never retrieved before this, so they aren't in a function parameter
}

/**
 * @param {string} localPath 
 * @param {string} robloxPath 
 * @param {any} properties 
 * @param {any} attributes 
 * @param {any} tags 
 * @param {any} metaLocalPath 
 * @param {any} initPath 
 * @param {number} mtimeMs 
 */
function mapLua(localPath, robloxPath, properties, attributes, tags, metaLocalPath, initPath, mtimeMs) {
	if (localPathIsIgnored(localPath)) return
	const context = (localPath.endsWith('.client.lua') || localPath.endsWith('.client.luau')) && 'Client' || (localPath.endsWith('.server.lua') || localPath.endsWith('.server.luau')) && 'Server' || 'Module'
	assignMap(robloxPath, {
		'Type': 'Lua',
		'Context': context,
		'Properties': properties,
		'Attributes': attributes,
		'Tags': tags,
		'Path': localPath,
		'Meta': metaLocalPath,
		'InitParent': initPath
	}, mtimeMs)
}

/**
 * @param {string} localPath 
 * @param {string} robloxPath 
 * @param {string} flag
 */
function mapDirectory(localPath, robloxPath, flag) {
	if (localPathIsIgnored(localPath)) return

	// Update hard link (doesn't trigger during initial mapping)
	if (hardLinkPaths)
		for (const hardLinkPath of hardLinkPaths)
			hardLinkRecursive(localPath, hardLinkPath)

	const localPathStats = fs.statSync(localPath)
	if (localPathStats.isFile()) {
		const robloxPathParsed = path.parse(robloxPath)
		if (flag != 'Modified') robloxPath = robloxPathParsed.dir + '/' + robloxPathParsed.name
		if (localPathExtensionIsMappable(localPath)) {
			mTimes[localPath] = localPathStats.mtimeMs
			const localPathParsed = path.parse(localPath)
			const localPathName = localPathParsed.name.toLowerCase()
			const localPathExt = localPathParsed.ext.toLowerCase()
			let properties;
			let attributes;
			let tags;
			let metaLocalPath;

			// Lua Meta Files
			if (localPathExt == '.lua' || localPathExt == '.luau' || localPathExt == '.txt' || localPathExt == '.csv') {
				let luaMeta;
				const title = (localPathExt == '.lua' || localPathExt == '.luau') && (localPathName.endsWith('.client') || localPathName.endsWith('.server')) && localPathParsed.name.slice(0, -7) || localPathParsed.name
				const metaLocalPathJson = localPath.slice(0, localPath.lastIndexOf('/')) + '/' + title + '.meta.json'
				const metaLocalPathYaml = localPath.slice(0, localPath.lastIndexOf('/')) + '/' + title + '.meta.yaml'
				const metaLocalPathToml = localPath.slice(0, localPath.lastIndexOf('/')) + '/' + title + '.meta.toml'
				if (fs.existsSync(metaLocalPathJson)) {
					luaMeta = validateJson('Meta', metaLocalPathJson, fs.readFileSync(metaLocalPathJson))
					metaLocalPath = metaLocalPathJson
				} else if (fs.existsSync(metaLocalPathYaml)) {
					luaMeta = validateYaml(metaLocalPathYaml, fs.readFileSync(metaLocalPathYaml))
					metaLocalPath = metaLocalPathYaml
				} else if (fs.existsSync(metaLocalPathToml)) {
					luaMeta = validateToml(metaLocalPathToml, fs.readFileSync(metaLocalPathToml))
					metaLocalPath = metaLocalPathToml
				}
				if (luaMeta) {
					properties = luaMeta['properties']
					attributes = luaMeta['attributes']
					tags = luaMeta['tags']
				} else {
					metaLocalPath = undefined
				}
			}

			// Lua
			if (localPathExt == '.lua' || localPathExt == '.luau') {
				let newRobloxPath = robloxPath
				if (flag != 'JSON' && flag != 'Modified') newRobloxPath = robloxPathParsed.dir + '/' + ((localPathName.endsWith('.client') || localPathName.endsWith('.server')) && localPathParsed.name.slice(0, -7) || localPathParsed.name)
				mapLua(localPath, newRobloxPath, properties, attributes, tags, metaLocalPath, undefined, localPathStats.mtimeMs)

			// Models
			} else if (localPathExt == '.rbxm' || localPathExt == '.rbxmx') {
				assignMap(robloxPath, {
					'Type': 'Model',
					'Path': localPath,
					'Meta': metaLocalPath
				}, localPathStats.mtimeMs)

			// JSON (non-meta)
			} else if (localPathExt == '.json' && !localPathName.endsWith('.meta')) {

				// Project Files
				if (localPathName.endsWith('.project')) {
					mTimes[localPath] = localPathStats.mtimeMs
					const subProjectJson = validateJson('SubProject', localPath, fs.readFileSync(localPath))
					if (subProjectJson) {
						const parentPathString = path.relative(path.resolve(), path.resolve(localPath, '..')).replace(/\\/g, '/')
						const externalPackageAppend = parentPathString != '' && parentPathString + '/' || ''
						mapJsonRecursive(localPath, subProjectJson, robloxPath, 'tree', true, externalPackageAppend, localPathStats.mtimeMs)
					}

				// Model Files
				} else if (localPathName.endsWith('.model')) {
					if (validateJson('Model', localPath, fs.readFileSync(localPath)))
						assignMap(flag != 'Modified' && robloxPath.slice(0, -6) || robloxPath, {
							'Type': 'JsonModel',
							'Path': localPath
						}, localPathStats.mtimeMs)

				// Excel Tables
				} else if (localPathName.endsWith('.excel')) {
					const excel = validateJson('Excel', localPath, fs.readFileSync(localPath))
					if (excel)
						assignMap(flag != 'Modified' && robloxPath.slice(0, -6) || robloxPath, {
							'Type': 'Excel',
							'Path': localPath,
							'Meta': path.relative(path.resolve(), path.resolve(localPath, '..', excel.spreadsheet)).replace(/\\/g, '/')
						}, localPathStats.mtimeMs)

				// Modules
				} else {
					assignMap(robloxPath, {
						'Type': 'JSON',
						'Path': localPath
					}, localPathStats.mtimeMs)
				}

			// YAML (non-meta)
			} else if (localPathExt == '.yaml' && !localPathName.endsWith('.meta')) {
				assignMap(robloxPath, {
					'Type': 'YAML',
					'Path': localPath
				}, localPathStats.mtimeMs)

			// TOML (non-meta)
			} else if (localPathExt == '.toml' && !localPathName.endsWith('.meta')) {
				assignMap(robloxPath, {
					'Type': 'TOML',
					'Path': localPath
				}, localPathStats.mtimeMs)

			// Plain Text
			} else if (localPathExt == '.txt') {
				assignMap(robloxPath, {
					'Type': 'PlainText',
					'Properties': properties,
					'Attributes': attributes,
					'Tags': tags,
					'Path': localPath
				}, localPathStats.mtimeMs)

			// Localization Tables
			} else if (localPathExt == '.csv') {
				assignMap(robloxPath, {
					'Type': 'Localization',
					'Properties': properties,
					'Attributes': attributes,
					'Tags': tags,
					'Path': localPath
				}, localPathStats.mtimeMs)
			}
		} else if (flag == 'JSON') {
			console.error(fileError(localPath), yellow('File is not of a mappable file type'))
		}
	} else if (localPathStats.isDirectory()) {
		if (fs.existsSync(localPath + '/default.project.json')) {

			// Projects
			mTimes[localPath] = localPathStats.mtimeMs
			const subProjectJsonPath = localPath + '/default.project.json'
			const subProjectJson = validateJson('SubProject', subProjectJsonPath, fs.readFileSync(subProjectJsonPath))
			if (subProjectJson) {
				const subProjectJsonStats = fs.statSync(localPath + '/default.project.json')
				mapJsonRecursive(subProjectJsonPath, subProjectJson, robloxPath, 'tree', true, localPath + '/', subProjectJsonStats.mtimeMs)
			}

		} else {

			mTimes[localPath] = localPathStats.mtimeMs
			const localPathParentName = localPath.split('/').pop()
			let className = 'Folder'
			let properties;
			let attributes;
			let tags;
			let clearOnSync;
			let metaLocalPath;

			// Init Meta Files
			{
				let initMeta;
				const metaLocalPathJson = localPath + '/init.meta.json'
				const metaLocalPathYaml = localPath + '/init.meta.yaml'
				const metaLocalPathToml = localPath + '/init.meta.toml'
				if (fs.existsSync(metaLocalPathJson)) {
					initMeta = validateJson('Meta', metaLocalPathJson, fs.readFileSync(metaLocalPathJson))
					metaLocalPath = metaLocalPathJson
				} else if (fs.existsSync(metaLocalPathYaml)) {
					initMeta = validateYaml('Meta', metaLocalPathYaml, fs.readFileSync(metaLocalPathYaml))
					metaLocalPath = metaLocalPathYaml
				} else if (fs.existsSync(metaLocalPathToml)) {
					initMeta = validateToml('Meta', metaLocalPathToml, fs.readFileSync(metaLocalPathToml))
					metaLocalPath = metaLocalPathToml
				}
				if (initMeta) {
					className = initMeta['className'] || 'Folder'
					properties = initMeta['properties']
					attributes = initMeta['attributes']
					tags = initMeta['tags']
					clearOnSync = initMeta['clearOnSync']
				} else {
					metaLocalPath = undefined
				}
			}

			// Lync-Style Init Lua
			if (fs.existsSync(localPath + '/' + localPathParentName + '.init.lua')) {
				mapLua(localPath + '/' + localPathParentName + '.init.lua', robloxPath, properties, attributes, tags, undefined, localPath, localPathStats.mtimeMs)
			} else if (fs.existsSync(localPath + '/' + localPathParentName + '.init.client.lua')) {
				mapLua(localPath + '/' + localPathParentName + '.init.client.lua', robloxPath, properties, attributes, tags, undefined, localPath, localPathStats.mtimeMs)
			} else if (fs.existsSync(localPath + '/' + localPathParentName + '.init.server.lua')) {
				mapLua(localPath + '/' + localPathParentName + '.init.server.lua', robloxPath, properties, attributes, tags, undefined, localPath, localPathStats.mtimeMs)
			} else if (fs.existsSync(localPath + '/' + localPathParentName + '.init.luau')) {
				mapLua(localPath + '/' + localPathParentName + '.init.luau', robloxPath, properties, attributes, tags, undefined, localPath, localPathStats.mtimeMs)
			} else if (fs.existsSync(localPath + '/' + localPathParentName + '.init.client.luau')) {
				mapLua(localPath + '/' + localPathParentName + '.init.client.luau', robloxPath, properties, attributes, tags, undefined, localPath, localPathStats.mtimeMs)
			} else if (fs.existsSync(localPath + '/' + localPathParentName + '.init.server.luau')) {
				mapLua(localPath + '/' + localPathParentName + '.init.server.luau', robloxPath, properties, attributes, tags, undefined, localPath, localPathStats.mtimeMs)

			// Rojo-Style Init Lua
			} else if (fs.existsSync(localPath + '/init.lua')) {
				mapLua(localPath + '/init.lua', robloxPath, properties, attributes, tags, undefined, localPath, localPathStats.mtimeMs)
			} else if (fs.existsSync(localPath + '/init.client.lua')) {
				mapLua(localPath + '/init.client.lua', robloxPath, properties, attributes, tags, undefined, localPath, localPathStats.mtimeMs)
			} else if (fs.existsSync(localPath + '/init.server.lua')) {
				mapLua(localPath + '/init.server.lua', robloxPath, properties, attributes, tags, undefined, localPath, localPathStats.mtimeMs)
			} else if (fs.existsSync(localPath + '/init.luau')) {
				mapLua(localPath + '/init.luau', robloxPath, properties, attributes, tags, undefined, localPath, localPathStats.mtimeMs)
			} else if (fs.existsSync(localPath + '/init.client.luau')) {
				mapLua(localPath + '/init.client.luau', robloxPath, properties, attributes, tags, undefined, localPath, localPathStats.mtimeMs)
			} else if (fs.existsSync(localPath + '/init.server.luau')) {
				mapLua(localPath + '/init.server.luau', robloxPath, properties, attributes, tags, undefined, localPath, localPathStats.mtimeMs)

			// Folders
			} else if (flag != 'JSON') {
				assignMap(robloxPath, {
					'Type': 'Instance',
					'ClassName': className,
					'Properties': properties,
					'Attributes': attributes,
					'Tags': tags,
					'ClearOnSync': clearOnSync,
					'Path': localPath,
					'Meta': metaLocalPath
				}, localPathStats.mtimeMs)
			}

			fs.readdirSync(localPath).forEach((dirNext) => {
				const dirNextLower = dirNext.toLowerCase()
				const localPathParentNameLower = localPathParentName.toLowerCase()
				// Do not map Init files. They were just mapped on this run of mapDirectory.
				switch (dirNextLower) {
					case 'init.meta.json':
					case 'init.meta.yaml':
					case 'init.meta.toml':
					case localPathParentNameLower + '.init.lua':
					case localPathParentNameLower + '.init.client.lua':
					case localPathParentNameLower + '.init.server.lua':
					case localPathParentNameLower + '.init.luau':
					case localPathParentNameLower + '.init.client.luau':
					case localPathParentNameLower + '.init.server.luau':
					case 'init.lua':
					case 'init.client.lua':
					case 'init.server.lua':
					case 'init.luau':
					case 'init.client.luau':
					case 'init.server.luau':
						break
					default:
						const filePathNext = localPath + '/' + dirNext
						mapDirectory(filePathNext, robloxPath + '/' + dirNext)
				}
			})
		}
	}
}

/**
 * @param {string} jsonPath 
 * @param {any} target 
 * @param {string} robloxPath 
 * @param {string} key 
 * @param {boolean} firstLoadingExternalPackage 
 * @param {any} externalPackageAppend 
 * @param {number} mtimeMs 
 */
function mapJsonRecursive(jsonPath, target, robloxPath, key, firstLoadingExternalPackage, externalPackageAppend, mtimeMs) {
	let nextRobloxPath = robloxPath + '/' + key
	if (firstLoadingExternalPackage) nextRobloxPath = robloxPath
	let localPath = target[key]['$path']
	if (externalPackageAppend && localPath) localPath = externalPackageAppend + localPath
	assignMap(nextRobloxPath, {
		'Type': 'Instance',
		'ClassName': robloxPath == 'tree' && key || target[key]['$className'] || 'Folder',
		'Properties': target[key]['$properties'],
		'Attributes': target[key]['$attributes'],
		'Tags': target[key]['$tags'],
		'Path': localPath,
		'ClearOnSync': target[key]['$clearOnSync'],
		'ProjectJson': jsonPath,
		'TerrainRegion': target[key]['$terrainRegion'],
		'TerrainMaterialColors': target[key]['$terrainMaterialColors']
	}, mtimeMs)
	for (const nextKey in target[key]) {
		if (nextKey[0] != '$' && typeof target[key][nextKey] != 'string' && !Array.isArray(target[key][nextKey])) {
			mapJsonRecursive(jsonPath, target[key], nextRobloxPath, nextKey, false, externalPackageAppend, mtimeMs)
		}
	}
	if (localPath) {
		if (typeof localPath == 'object') {
			mapDirectory(localPath.optional, nextRobloxPath, 'JSON')
		} else if (fs.existsSync(localPath)) {
			mapDirectory(localPath, nextRobloxPath, 'JSON')
		} else {
			console.error(fileError(localPath), yellow('Path does not exist'))
		}
	}
}

function changedJson() {
	if (DEBUG) console.log('Loading', cyan(PROJECT_JSON))
	projectJson = validateJson('MainProject', PROJECT_JSON, fs.readFileSync(PROJECT_JSON))
	if (!projectJson) {
		console.log()
		console.error(red('Terminated:'), yellow('Project'), cyan(PROJECT_JSON), yellow('is invalid'))
		process.exit()
	}
	if (MODE != 'serve' && MODE != 'open' && MODE != 'build') return
	let globIgnorePathsArr = [
		PROJECT_JSON,
		path.relative(path.resolve(), path.resolve(PROJECT_JSON, '../sourcemap.json')).replace(/\\/g, '/'),
		'*.lock',
		'.git/*',
		'~$*'
	]
	if (projectJson.globIgnorePaths)
		globIgnorePathsArr.push(projectJson.globIgnorePaths)
	globIgnorePaths = `{${globIgnorePathsArr.join(',')}}`
	globIgnorePathsPicoMatch = picomatch(globIgnorePaths)
	if (MODE == 'open' || MODE == 'build') {
		if (projectJson.base == '') {
			console.log()
			console.error(red('Terminated:'), green('base'), yellow('cannot be a blank string with OPEN or BUILD mode'))
			process.exit()
		} else if (!fs.existsSync(projectJson.base)) {
			console.log()
			console.error(red('Terminated:'), yellow('Base'), cyan(projectJson.base), yellow('does not exist'))
			process.exit()
		} else if (projectJson.build == '') {
			console.log()
			console.error(red('Terminated:'), green('build'), yellow('cannot be a blank string with OPEN or BUILD mode'))
			process.exit()
		}
	}
	if (DEBUG) console.log('Mapping', green(projectJson.name))
	map = {}
	const projectJsonStats = fs.statSync(PROJECT_JSON)
	for (const service in projectJson.tree) {
		if (service == '$className') continue // Fix for Roblox LSP source map
		mapJsonRecursive(PROJECT_JSON, projectJson.tree, 'tree', service, false, undefined, projectJsonStats.mtimeMs)
	}
}


// Sync Functions

/**
 * @param {string} existingPath 
 * @param {string} hardLinkPath 
 */
function hardLinkRecursive(existingPath, hardLinkPath) {
	if (localPathIsIgnored(existingPath)) return
	const stats = fs.statSync(existingPath)
	const newPath = path.resolve(hardLinkPath, path.relative(path.resolve(), existingPath))
	try {
		const parentPath = path.resolve(newPath, '..')
		if (!fs.existsSync(parentPath)) {
			fs.mkdirSync(parentPath)
		}
		if (stats.isDirectory()) {
			if (!fs.existsSync(newPath)) {
				fs.mkdirSync(newPath)
			}
			fs.readdirSync(existingPath).forEach((dirNext) => {
				hardLinkRecursive(path.resolve(existingPath, dirNext), hardLinkPath)
			})
		} else {
			if (fs.existsSync(newPath)) {
				fs.unlinkSync(newPath)
			}
			fs.linkSync(existingPath, newPath)
		}
	} catch (err) {
		if (DEBUG) console.error(red('Hard link error:'), yellow(err))
	}
}

/**
 * @param {string | any} url 
 * @param {OutgoingHttpHeaders} headers 
 * @param {string} responseType 
 * @returns 
 */
async function getAsync(url, headers, responseType) {
	const newHeaders = { 'user-agent': 'node.js' }
	for (const header in headers) {
		newHeaders[header] = headers[header]
	}
	return new Promise ((resolve, reject) => {
		const req = https.get(url, {
			headers: newHeaders
		}, (res) => {
			let data = []
			res.on('data', (chunk) => {
				data.push(chunk)
			})
			res.on('end', () => {
				try {
					let buffer = Buffer.concat(data)
					switch (responseType) {
						case 'json':
							resolve(JSON.parse(buffer.toString()))
							break
						default:
							resolve(buffer)
					}
				} catch (err) {
					reject(err)
				}
			})
		})
		req.on('error', (err) => {
			reject(err)
		})
		req.end()
	})
}


// Main

(async function () {

	// Check for updates

	if (CONFIG.AutoUpdate) {
		console.log('Checking for updates . . .')
		try {
			// Grab latest version info
			let latest = await getAsync(`https://api.github.com/repos/${CONFIG.GithubUpdateRepo}/releases${!CONFIG.GithubUpdatePrereleases && '/latest' || ''}`, {}, 'json')
			if (CONFIG.GithubUpdatePrereleases) latest = latest[0]
			if (!latest || !('id' in latest)) throw new Error('No response from server')
			if (latest.id != CONFIG.LatestId) {
				const updateFile = path.resolve(LYNC_INSTALL_DIR, `Lync-${latest.tag_name}.zip`)
				const updateFolder = path.resolve(LYNC_INSTALL_DIR, 'Lync-' + latest.tag_name)

				// Download latest version
				console.log(`Updating to ${green(latest.name)} . . .`)
				const update = await getAsync(`https://github.com/${CONFIG.GithubUpdateRepo}/releases/download/${latest.tag_name}/lync-${latest.tag_name}-${PLATFORM}-${os.arch()}.zip`, {})
				fs.writeFileSync(updateFile, update, 'binary')
				await extract(updateFile, { dir: updateFolder })
				fs.rmSync(updateFile, { force: true })

				// Write new version
				CONFIG.LatestId = latest.id
				fs.writeFileSync(CONFIG_PATH, JSON.stringify(CONFIG, null, '\t'))

				// Copy Lync binary and restart
				const executable = process.execPath
				const tempExecutable = executable + '.temp'
				if (fs.existsSync(tempExecutable))
					fs.rmSync(tempExecutable, { force: true })
				fs.renameSync(executable, executable + '.temp')
				if (PLATFORM == 'windows') {
					fs.renameSync(path.resolve(updateFolder, 'lync.exe'), path.resolve(LYNC_INSTALL_DIR, path.parse(executable).base))
				} else {
					fs.renameSync(path.resolve(updateFolder, 'lync'), path.resolve(LYNC_INSTALL_DIR, path.parse(executable).base))
				}

				// Cleanup
				fs.rmSync(updateFolder, { force: true, recursive: true })

				// Restart Lync
				console.clear()
				process.argv.shift()
				spawnSync(executable, process.argv, {
					cwd: process.cwd(),
					detached: false,
					stdio: 'inherit'
				})
				process.exit()
			}
			console.clear()
		} catch (err) {
			console.error(red('Failed to update:'), err)
			console.log()
		}
	}

	// Begin

	console.log('Path:', cyan(path.resolve()))
	console.log('Args:', ARGS)

	http.globalAgent.maxSockets = 65535

	// Map project

	if (!fs.existsSync(PROJECT_JSON)) {
		console.log()
		console.error(red('Terminated:'), yellow(Project), cyan(PROJECT_JSON), yellow('does not exist'))
		process.exit()
	}
	changedJson()

	// Download sources
	if (MODE == 'fetch') {
		console.log()
		for (const index in projectJson.sources) {
			const source = projectJson.sources[index]
			console.log('Fetching source', green(source.name), '. . .')
			try {
				let contents;
				if (source.type == 'GET') {
					contents = await getAsync(source.url, source.headers)
				} else if (source.type == 'POST') {
					contents = await postAsync(source.url, source.headers, source.postData)
				}
				fs.writeFileSync(source.path, contents)
				console.log(green(source.name), 'saved to', cyan(source.path))
			} catch (err) {
				console.error(red('Fetch error:'), yellow(err))
			}
		}
		process.exit()

	// Build
	} else if (MODE == 'build') {

		const buildScriptPath = projectJson.build + '.luau'
		const lunePath = PLATFORM == 'windows' && CONFIG.LunePath.replace('%LOCALAPPDATA%', process.env.LOCALAPPDATA)
			|| PLATFORM == 'macos' && CONFIG.LunePath.replace('$HOME', process.env.HOME)
			|| CONFIG.LunePath

		// Map loadstring calls (needed until Lune implements loadstring)
		let loadstringMapEntries = {}
		let loadstringMap = ''

		function toEscapeSequence(str) {
			let escapeSequence = ''
			let i = str.length
			while (i--)
				escapeSequence = '\\' + str.charCodeAt(i) + escapeSequence
			return escapeSequence
		}

		function mapProperties(properties) {
			for (const property in properties) {
				let value = properties[property]
				if (Array.isArray(value) && !(value in loadstringMapEntries)) {
					loadstringMap += `\t[ "${toEscapeSequence('return ' + value)}" ] = ${value};\n`
					loadstringMapEntries[value] = true
				}
			}
		}

		for (const key in map) {
			const mapping = map[key]
			if (mapping.Type == 'JsonModel') {
				function mapJsonModel(json) {
					for (const key in json) {
						const jsonModelMapping = json[key]
						if (typeof jsonModelMapping == 'object') {
							if ('Properties' in jsonModelMapping)
								mapProperties(jsonModelMapping.Properties)
							mapJsonModel(jsonModelMapping)
						}
					}
				}
				const jsonModel = validateJson('Model', mapping.Path, fs.readFileSync(mapping.Path))
				if (jsonModel) mapJsonModel(jsonModel)
			} else if ('Properties' in mapping)
				mapProperties(mapping.Properties)
			if ('TerrainMaterialColors' in mapping)
				mapProperties(mapping.TerrainMaterialColors)
		}

		// Fetch script functions
		let pluginSource = fs.readFileSync(path.resolve(__dirname, 'RobloxPluginSource/Plugin.lua'), { encoding: 'utf8' })
		pluginSource = pluginSource.substring(pluginSource.indexOf('--offline-start') + 15, pluginSource.indexOf('--offline-end'))

		// Write validation script
		if (DEBUG) console.log('Writing validation script . . .')
		let validationScript = fs.readFileSync(path.resolve(__dirname, 'luneBuildTemplate.luau'))
		validationScript += `${pluginSource}\n`
		validationScript += `for _, lua in {\n`
		for (const entry in loadstringMapEntries) {
			validationScript += `\t"${toEscapeSequence(entry)}";\n`
		}
		validationScript += '} do\n\tlocal HttpService;\n\tif not validateLuaProperty(lua) then\n\t\terror(`Security - Lua string [ {lua} ] failed validation`)\n\tend\nend\n'
		if (fs.existsSync(buildScriptPath))
			fs.rmSync(buildScriptPath)
		fs.writeFileSync(buildScriptPath, validationScript)

		// Validate loadstrings
		if (DEBUG) console.log('Validating loadstrings . . .')
		const validationStatus = spawnSync(lunePath, [ `${buildScriptPath}` ], {
			cwd: process.cwd(),
			detached: false,
			stdio: 'inherit'
		}).status
		if (validationStatus == null) {
			console.error(red('Build error:'), yellow('Lune executable not found:'), cyan(lunePath))
			process.exit(1)
		} else if (validationStatus != 0) {
			console.error(red('Build error:'), yellow('Validation script failed with status', validationStatus))
			process.exit(2)
		}

		// Write build script
		if (DEBUG) console.log('Writing build script . . .')
		let buildScript = fs.readFileSync(path.resolve(__dirname, 'luneBuildTemplate.luau'))
		buildScript += `local game = roblox.deserializePlace(fs.readFile("${projectJson.base}"))\n`
		buildScript += 'local workspace = game:GetService("Workspace")\n'
		buildScript += `${pluginSource}\n`
		buildScript += `map = net.jsonDecode("${toEscapeSequence(JSON.stringify(map, null, '\t'))}")\n`
		buildScript += `buildAll()\n`
		buildScript += `fs.writeFile("${projectJson.build}", roblox.serializePlace(game))\n`
		if (fs.existsSync(buildScriptPath))
			fs.rmSync(buildScriptPath)
		fs.writeFileSync(buildScriptPath, buildScript)

		// Build RBXL
		if (DEBUG) console.log('Building RBXL . . .')
		const build = spawn(lunePath, [ `${buildScriptPath}` ], {
			cwd: process.cwd(),
			detached: false,
			stdio: 'inherit'
		})
		build.on('close', (status) => {
			if (status == null) {
				console.error(red('Build error:'), yellow('Lune executable not found:'), cyan(lunePath))
				process.exit(1)
			} else if (status != 0) {
				console.error(red('Build error:'), yellow('Build script failed with status'), status)
				process.exit(3)
			}
			console.log('Build saved to', cyan(projectJson.build))
			fs.rmSync(buildScriptPath)
			process.exit()
		})

	// Sync
	} else {

		// Copy base file
		if (MODE == 'open') {
			if (DEBUG) console.log('Copying', cyan(projectJson.base), '->', cyan(projectJson.build))
			fs.copyFileSync(projectJson.base, projectJson.build)
		}

		if (PLATFORM == 'windows' || PLATFORM == 'macos') {

			// Copy plugin
			const pluginsPath = path.resolve(PLATFORM == 'windows' && CONFIG.RobloxPluginsPath.replace('%LOCALAPPDATA%', process.env.LOCALAPPDATA) || PLATFORM == 'macos' && CONFIG.RobloxPluginsPath.replace('$HOME', process.env.HOME))
			if (!fs.existsSync(pluginsPath)) {
				if (DEBUG) console.log('Creating folder', cyan(pluginsPath))
				fs.mkdirSync(pluginsPath)
			}
			if (DEBUG) console.log('Copying', cyan(path.resolve(__dirname, 'Plugin.rbxm')), '->', cyan(path.resolve(pluginsPath, 'Lync.rbxm')))
			fs.copyFileSync(path.resolve(__dirname, 'Plugin.rbxm'), path.resolve(pluginsPath, 'Lync.rbxm'))

			// Open Studio
			if (MODE == 'open') {
				if (DEBUG) console.log('Opening', cyan(projectJson.build))
				spawn((PLATFORM == 'macos' && 'open -n ' || '') + `"${projectJson.build}"`, [], {
					stdio: 'ignore',
					detached: true,
					shell: true,
					windowsHide: true
				})
			}
		}

		// Sync file changes
		chokidar.watch('.', {
			cwd: path.resolve(),
			disableGlobbing: true,
			ignoreInitial: true,
			ignored: globIgnorePaths,
			persistent: true,
			ignorePermissionErrors: true,
			alwaysStat: true,
			usePolling: true
		}).on('all', function(event, localPath, localPathStats) {
			if (DEBUG) console.log('E', yellow(event), cyan(localPath))
			try {
				if (localPath) {
					localPath = path.relative(path.resolve(), localPath)

					if (!localPathIsIgnored(localPath)) {
						localPath = localPath.replace(/\\/g, '/')
						const parentPathString = path.relative(path.resolve(), path.resolve(localPath, '..')).replace(/\\/g, '/')

						if (localPath in mTimes) {
	
							// Deleted
							if (!localPathStats) {
								console.log('D', cyan(localPath))
								for (const key in map) {
	
									// Direct
									if (map[key].Path && (map[key].Path == localPath || map[key].Path.startsWith(localPath + '/'))) {
										delete mTimes[localPath]
										delete mTimes[map[key].Path]
										delete map[key]
										modified[key] = false
										modified_playtest[key] = false
										modified_sourcemap[key] = false
										if (localPathIsInit(localPath) && fs.existsSync(parentPathString)) {
											mapDirectory(parentPathString, key, 'Modified')
										}
									}
	
									// Meta
									if (key in map && map[key].Meta && (map[key].Meta == localPath || map[key].Meta.startsWith(localPath + '/'))) {
										if (fs.existsSync(map[key].Path)) {
											mapDirectory(map[key].Path, key, 'Modified')
										}
									}
	
									// JSON member
									if (key in map && map[key].ProjectJson == localPath) {
										if (fs.existsSync(map[key].Path)) {
											mapDirectory(map[key].Path, key, 'Modified')
										}
									}
								}
	
							// Changed
							} else if (localPathStats.isFile() && mTimes[localPath] != localPathStats.mtimeMs) {
								console.log('M', cyan(localPath))
								for (const key in map) {
									if (map[key].InitParent == parentPathString) {
										mapDirectory(parentPathString, key, 'Modified')
									} else if (map[key].Meta == localPath) {
										mapDirectory(map[key].Path, key, 'Modified')
									} else if (map[key].Path == localPath) {
										mapDirectory(localPath, key, 'Modified')
									}
								}
								mTimes[localPath] = localPathStats.mtimeMs
							}
	
						} else if ((event == 'add' | event == 'addDir') && localPathStats) {
	
							// Added
							if (parentPathString in mTimes && (!localPathStats.isFile() || localPathExtensionIsMappable(localPath))) {
								console.log('A', cyan(localPath))
								for (const key in map) {
									if (map[key].Path == parentPathString || map[key].InitParent == parentPathString) {
										const localPathParsed = path.parse(localPath)
										const localPathName = localPathParsed.name.toLowerCase()
										const localPathExt = localPathParsed.ext.toLowerCase()
	
										// Remap adjacent matching file
										if (localPathName != 'init.meta' && localPathName.endsWith('.meta') && (localPathExt == '.json' || localPathExt == '.yaml' || localPathExt == '.toml')) {
											const title = localPathParsed.name.slice(0, -5)
											if (fs.existsSync(localPathParsed.dir + '/' + title + '.lua')) {
												delete map[key]
												mapDirectory(localPath, title + '.lua')
											} else if (fs.existsSync(localPathParsed.dir + '/' + title + '.client.lua')) {
												delete map[key]
												mapDirectory(localPath, title + '.client.lua')
											} else if (fs.existsSync(localPathParsed.dir + '/' + title + '.server.lua')) {
												delete map[key]
												mapDirectory(localPath, title + '.server.lua')
											} else if (fs.existsSync(localPathParsed.dir + '/' + title + '.luau')) {
												delete map[key]
												mapDirectory(localPath, title + '.luau')
											} else if (fs.existsSync(localPathParsed.dir + '/' + title + '.client.luau')) {
												delete map[key]
												mapDirectory(localPath, title + '.client.luau')
											} else if (fs.existsSync(localPathParsed.dir + '/' + title + '.server.luau')) {
												delete map[key]
												mapDirectory(localPath, title + '.server.luau')
											} else {
												console.error(fileError(localPath), yellow('Stray meta file'))
												return
											}
	
										// Remap parent folder
										} else if (localPathIsInit(localPath) || localPathName == 'init.meta' && (localPathExt == '.json' || localPathExt == '.yaml' || localPathExt == '.toml') || localPathParsed.base == 'default.project.json') {
											delete map[key]
											mapDirectory(parentPathString, key)
	
										// Map only file or directory
										} else {
											mapDirectory(localPath, key + '/' + localPathParsed.base)
										}
									}
								}
								if (!mTimes[localPath]) console.error(red('Lync bug:'), yellow('Failed to add'), cyan(localPath))
							}
						}
	
						// Modify sourcemap
						if (CONFIG.GenerateSourcemap && Object.keys(modified_sourcemap).length > 0) {
							generateSourcemap(PROJECT_JSON, modified_sourcemap, projectJson)
							modified_sourcemap = {}
						}
					}
				}
			} catch (err) {
				console.error(red('Sync error:'), err)
			}
		})
	}

	// Start server

	http.createServer(function(req, res) {
		if (MODE != 'build') {
			if (!(req.socket.remoteAddress in securityKeys)) {
				if (!('key' in req.headers)) {
					const errText = 'Missing Key header'
					console.error(red('Server error:'), yellow(errText))
					console.log('Headers:', req.headers)
					res.writeHead(403)
					res.end(errText)
					return
				}
				securityKeys[req.socket.remoteAddress] = req.headers.key
				console.log(`Client connected: ${yellow(req.socket.remoteAddress)}`)
			} else if (req.headers.key != securityKeys[req.socket.remoteAddress]) {
				const errText = `Security key mismatch. The current session will now be terminated. (Key = ${req.headers.key})\nPlease check for any malicious plugins or scripts and try again.`
				console.log()
				console.error(red('Terminated:'), yellow(errText))
				res.writeHead(403)
				res.end(errText)
				process.exit()
			}
		}

		switch (req.headers.type) {
			case 'Map':
				// Create content hard links

				hardLinkPaths = []
				if (PLATFORM == 'windows') {
					const versionsPath = path.resolve(CONFIG.RobloxVersionsPath.replace('%LOCALAPPDATA%', process.env.LOCALAPPDATA))
					fs.readdirSync(versionsPath).forEach((dirNext) => {
						const stats = fs.statSync(path.resolve(versionsPath, dirNext))
						if (stats.isDirectory() && fs.existsSync(path.resolve(versionsPath, dirNext, 'RobloxStudioBeta.exe'))) {
							const hardLinkPath = path.resolve(versionsPath, dirNext, 'content/lync')
							if (!fs.existsSync(hardLinkPath)) {
								fs.mkdirSync(hardLinkPath)
							}
							hardLinkPaths.push(hardLinkPath)
						}
					})
					// Studio Mod Manager
					const modManagerContentPath = path.resolve(CONFIG.StudioModManagerContentPath.replace('%LOCALAPPDATA%', process.env.LOCALAPPDATA))
					if (fs.existsSync(modManagerContentPath)) {
						const hardLinkPath = path.resolve(modManagerContentPath, 'lync')
						if (!fs.existsSync(hardLinkPath)) {
							fs.mkdirSync(hardLinkPath)
						}
						hardLinkPaths.push(hardLinkPath)
					}
				} else if (PLATFORM == 'macos') {
					const contentPath = path.resolve(CONFIG.RobloxContentPath)
					const hardLinkPath = path.resolve(contentPath, 'lync')
					if (!fs.existsSync(hardLinkPath)) {
						fs.mkdirSync(hardLinkPath)
					}
					hardLinkPaths.push(hardLinkPath)
				}
				for (const hardLinkPath of hardLinkPaths) {
					try {
						fs.rmSync(hardLinkPath, { force: true, recursive: true })
					} catch (err) {}
					hardLinkRecursive(path.resolve(), hardLinkPath)
				}

				// Send map
				map.Version = VERSION
				map.Debug = DEBUG
				map.ServePlaceIds = projectJson.servePlaceIds
				const mapJsonString = JSON.stringify(map)
				delete map['Version']
				delete map['Debug']
				delete map['ServePlaceIds']
				if ('playtest' in req.headers) {
					modified_playtest = {}
				} else {
					modified = {}
				}
				res.writeHead(200)
				res.end(mapJsonString)
				break

			case 'Modified':
				let modifiedJsonString;
				if ('playtest' in req.headers) {
					modifiedJsonString = JSON.stringify(modified_playtest)
					modified_playtest = {}
				} else {
					modifiedJsonString = JSON.stringify(modified)
					modified = {}
				}
				res.writeHead(200)
				res.end(modifiedJsonString)
				break

			case 'Source':
				try {
					let read = fs.readFileSync(req.headers.path)

					// Parse JSON
					if (req.headers.datatype == 'JSON') {
						const json = validateJson(null, req.headers.path, read)
						if (json) read = LUA.format(json, { singleQuote: false, spaces: '\t' })

					// Convert YAML to JSON
					} else if (req.headers.datatype == 'YAML') {
						const yaml = validateYaml(null, req.headers.path, read)
						if (yaml) read = LUA.format(yaml, { singleQuote: false, spaces: '\t' })

					// Convert TOML to JSON
					} else if (req.headers.datatype == 'TOML') {
						const toml = validateToml(null, req.headers.path, read)
						if (toml) read = LUA.format(toml, { singleQuote: false, spaces: '\t' })

					// Read and convert Excel Tables to JSON
					} else if (req.headers.datatype == 'Excel') {
						let tableDefinitions = validateJson('Excel', req.headers.path, read)
						if (tableDefinitions) {
							const excelFilePath = path.resolve(req.headers.path, '..', tableDefinitions.spreadsheet)

							if (!fs.existsSync(excelFilePath)) {
								console.error(fileError(excelFilePath), yellow('Excel file does not exist'))
							} else {
								const excelFile = XLSX.readFile(excelFilePath)

								// Convert Excel 'Defined Name' to 'Ref'
								for (const definedName of excelFile.Workbook.Names) {
									if (definedName.Name == tableDefinitions.ref) {
										tableDefinitions.ref = definedName.Ref
										break
									}
								}
		
								// Find current sheet and range to read from
								let sheet;
								let range;
								if (tableDefinitions.ref.includes('!')) {
									const ref = tableDefinitions.ref.split('!')
									sheet = excelFile.Sheets[ref[0].replace('=', '').replaceAll('\'', '')]
									range = XLSX.utils.decode_range(ref[1])
								} else {
									sheet = excelFile.Sheets[excelFile.SheetNames[0]]
									range = XLSX.utils.decode_range(tableDefinitions.ref.replace('=', ''))
								}
		
								// Convert cells to dict
								const sheetJson = XLSX.utils.sheet_to_json(sheet, {
									range: range,
									header: 1,
									defval: null
								})
								const entries = tableDefinitions.numColumnKeys > 0 && {} || []
								const startRow = tableDefinitions.hasHeader && 1 || 0
								const startColumn = tableDefinitions.numColumnKeys
								const header = sheetJson[0]
								for (let row = startRow; row < sheetJson.length; row++) {
									for (let column = startColumn; column < header.length; column++) {
										const key = tableDefinitions.hasHeader && header[column] || (column - startColumn)
										let target = entries
										if (tableDefinitions.numColumnKeys > 0) {
											for (let columnKeyIndex = 0; columnKeyIndex < tableDefinitions.numColumnKeys; columnKeyIndex++) {
												const columnKey = sheetJson[row][columnKeyIndex]
												if (!columnKey) {
													target = null
													break
												}
												if (!(columnKey in target)) {
													target[columnKey] = tableDefinitions.hasHeader && {} || []
												}
												target = target[columnKey]
											}
										} else {
											const indexKey = row - startRow
											if (!target[indexKey]) {
												target[indexKey] = tableDefinitions.hasHeader && {} || []
											}
											target = target[indexKey]
										}
										if (target)
											target[key] = sheetJson[row][column]
									}
								}
								read = LUA.format(entries, { singleQuote: false, spaces: '\t' })
							}
						}

					// Convert Localization CSV to JSON
					} else if (req.headers.datatype == 'Localization') {
						let entries = []
						const csv = parseCSV(UTF8.decode(read))
						for (let index = 0; index < csv.length; index++) {
							const entry = csv[index]
							const values = {}
							for (const key in entry) {
								switch (key) {
									case 'Key':
									case 'Source':
									case 'Context':
									case 'Example':
										break
									default:
										values[key] = entry[key]
								}
							}
							entries.push({ Key: entry.Key, Source: entry.Source, Context: entry.Context, Example: entry.Example, Values: values })
						}
						read = JSON.stringify(entries)
					}

					if (read) {
						res.writeHead(200)
						res.end(read)
					} else {
						res.writeHead(403)
						res.end('Invalid read')
					}
				} catch (err) {
					console.error(red('Server error:'), err)
					res.writeHead(500)
					res.end(err.toString())
				}
				break

			case 'ReverseSync':
				const workingDir = path.resolve()
				if (path.resolve(req.headers.path).substring(0, workingDir.length) != workingDir) {
					res.writeHead(403)
					res.end('File not located in project directory')
					break
				}
				const localPathExt = path.parse(req.headers.path).ext.toLowerCase()
				if (localPathExt != '.lua' && localPathExt != '.luau') {
					res.writeHead(403)
					res.end('File extension must be lua or luau')
					break
				}
				let data = []
				req.on('data', (chunk) => {
					data.push(chunk)
				})
				req.on('end', () => {
					try {
						let buffer = Buffer.concat(data)
						fs.writeFileSync(req.headers.path, buffer.toString())
						res.writeHead(200)
						res.end()
					} catch (err) {
						console.error(red('Server error:'), err)
						res.writeHead(400)
						res.end(err.toString())
					}
				})
				break

			case 'Resume':
				res.writeHead(200)
				res.end()
				break

			default:
				res.writeHead(400)
				res.end('Missing / invalid type header')
		}
	})
	.on('error', function(err) {
		console.log()
		console.error(red('Terminated: Server error:'), err)
		process.exit()
	})
	.listen(projectJson.port, function() {
		console.log(`Serving ${green(projectJson.name)} on port ${yellow(projectJson.port)}\n`)

		// Generate sourcemap

		if (CONFIG.GenerateSourcemap) {
			const startTime = Date.now()
			if (DEBUG) console.log('Generating', cyan('sourcemap.json'), '. . .')
			generateSourcemap(PROJECT_JSON, map, projectJson)
			if (DEBUG) console.log('Generated', cyan('sourcemap.json'), 'in', (Date.now() - startTime) / 1000, 'seconds')
			modified_sourcemap = {}
		}
	})
})()
