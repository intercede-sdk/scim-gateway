'use strict'

const http = require('http')
const https = require('https')
const HttpsProxyAgent = require('https-proxy-agent')
const URL = require('url').URL
const querystring = require('querystring')

// mandatory plugin initialization - start
const path = require('path')
let ScimGateway = null
try {
  ScimGateway = require('scimgateway')
} catch (err) {
  ScimGateway = require('./scimgateway')
}
const scimgateway = new ScimGateway()
const pluginName = path.basename(__filename, '.js')
const configDir = path.join(__dirname, '..', 'config')
const configFile = path.join(`${configDir}`, `${pluginName}.json`)
const validScimAttr = [] // for now, all attributes are supported, but we may want to limit what we support
let config = require(configFile).endpoint
config = scimgateway.processExtConfig(pluginName, config) // add any external config process.env and process.file
scimgateway.authPassThroughAllowed = false // true enables auth passThrough (no scimgateway authentication). scimgateway instead includes ctx (ctx.request.header) in plugin methods. Note, requires plugin-logic for handling/passing ctx.request.header.authorization to be used in endpoint communication
// mandatory plugin initialization - end

// MyID configuration
// This is the group users are added to. Calling /api/Groups/browse can show top-level groups
const defaultGroup = {
  id: 'C1D184E2-B52C-4543-8C06-762F10177689',
  name: 'Root'
}

const _serviceClient = {}

// =================================================
// getUsers
// =================================================
scimgateway.getUsers = async (baseEntity, getObj, attributes, ctx) => {
  //
  // "getObj" = { attribute: <>, operator: <>, value: <>, rawFilter: <>, startIndex: <>, count: <> }
  // rawFilter is always included when filtering
  // attribute, operator and value are included when requesting unique object or simpel filtering
  // See comments in the "mandatory if-else logic - start"
  //
  // "attributes" is array of attributes to be returned - if empty, all supported attributes should be returned
  // Should normally return all supported user attributes having id and userName as mandatory
  // id and userName are most often considered as "the same" having value = <UserID>
  // Note, the value of returned 'id' will be used as 'id' in modifyUser and deleteUser
  // scimgateway will automatically filter response according to the attributes list
  //
  const action = 'getUsers'
  scimgateway.logger.debug(`${pluginName}[${baseEntity}] handling "${action}" getObj=${getObj ? JSON.stringify(getObj) : ''} attributes=${attributes}`)

  const method = 'GET'
  let path
  const body = null

  // start mandatory if-else logic
  if (getObj.operator) {
    if (getObj.operator === 'eq' && ['id', 'userName', 'externalId'].includes(getObj.attribute)) {
      if (getObj.attribute === 'id') path = `/People/${getObj.value}`
      else if (getObj.attribute === 'userName') path = `/People?logonName=${getObj.value}`
      // GET /Users/bjensen?attributes=
      else path = `/Users?filter=${getObj.attribute} eq "${getObj.value}"${attributes.length > 0 ? '&attributes=' + attributes.join() : ''}` // GET /Users?filter=userName eq "bjensen"&attributes=userName,active,name.givenName,name.familyName,name.formatted,title,emails,phoneNumbers,entitlements
    } else if (getObj.operator === 'eq' && getObj.attribute === 'group.value') {
      // optional - only used when groups are member of users, not default behavior - correspond to getGroupUsers() in versions < 4.x.x
      path = `/Users?filter=${getObj.attribute} eq "${getObj.value}"${attributes.length > 0 ? '&attributes=' + attributes.join() : ''}`
    } else {
      // optional - simple filtering
      path = `/Users?filter=${getObj.attribute} ${getObj.operator} "${getObj.value}"${attributes.length > 0 ? '&attributes=' + attributes.join() : ''}`
    }
  } else if (getObj.rawFilter) {
    // optional - advanced filtering having and/or/not - use getObj.rawFilter
    throw new Error(`${action} error: not supporting advanced filtering: ${getObj.rawFilter}`)
  } else {
    // mandatory - no filtering (!getObj.operator && !getObj.rawFilter) - all users to be returned - correspond to exploreUsers() in versions < 4.x.x
    path = `/People${attributes.length > 0 ? '?attributes=' + attributes.join() : ''}`
  }
  // end mandatory if-else logic

  if (!path) throw new Error(`${action} error: mandatory if-else logic not fully implemented`)

  const ret = {
    // itemsPerPage will be set by scimgateway
    Resources: [],
    totalResults: null
  }

  try {
    const response = await doRequest(baseEntity, method, path, body)
    if (response.statusCode < 200 || response.statusCode > 299) {
      throw new Error(`${response.statusMessage} - ${JSON.stringify(response.body)}`)
    } else if (!response.body) {
      throw new Error('got empty response on REST request')
    }

    let responseArr = []
    if (Array.isArray(response.body.results)) responseArr = response.body.results
    else if (!response.body.Resources) {
      if (Array.isArray(response.body)) responseArr = response.body
      else if (typeof response.body === 'object' && Object.keys(response.body).length > 0) responseArr = [response.body]
    }

    if (!getObj.startIndex && !getObj.count) {
      // client request without paging
      getObj.startIndex = 1
      getObj.count = responseArr.length
    }

    for (let i = 0; i < responseArr.length && i + 1 - getObj.startIndex < getObj.count; ++i) {
      const userObj = responseArr[i]
      if (!userObj || Object.keys(userObj).length < 1) continue

      const objCompanyEntitlement = scimgateway.getArrayObject(userObj, 'entitlements', 'company')

      let arrEntitlement
      if (objCompanyEntitlement) arrEntitlement = [objCompanyEntitlement]

      const retObj = {
        // scimgateway strips attributes according to attributes list and will also auto include groups if needed
        id: userObj.id || undefined, // id and userName is mandatory and most often set to the same value
        userName: userObj.logonName || undefined,
        active: userObj.enabled === 1 || (userObj.enabled === 0 ? false : undefined),
        name: {
          givenName: userObj.firstName || userObj.name?.first || undefined,
          familyName: userObj.surname || userObj.name?.last || undefined,
          formatted: userObj.name?.fullName || undefined
        },
        title: userObj.name?.title || undefined,
        emails: userObj.contact?.emailAddress ? [{ type: 'work', value: userObj.contact.emailAddress }] : undefined,
        phoneNumbers: userObj.contact?.phoneNumber ? [{ type: 'work', value: userObj.contact.phoneNumber }] : undefined,
        entitlements: arrEntitlement
      }

      ret.Resources.push(retObj)
    }

    ret.totalResults = responseArr.length // not needed if client or endpoint do not support paging
    return ret
  } catch (err) {
    throw new Error(`${action} error: ${err.message}`)
  }
}

// =================================================
// createUser
// =================================================
scimgateway.createUser = async (baseEntity, userObj, ctx) => {
  const action = 'createUser'
  scimgateway.logger.debug(`${pluginName}[${baseEntity}] handling "${action}" userObj=${JSON.stringify(userObj)}`)

  const notValid = scimgateway.notValidAttributes(userObj, validScimAttr)
  if (notValid) {
    throw new Error(`${action} error: unsupported scim attributes: ${notValid} (supporting only these attributes: ${validScimAttr.toString()})`)
  }

  const method = 'POST'
  const path = '/People'
  const body = {
    logonName: userObj.userName,
    enabled: userObj.active || typeof userObj.active == 'undefined' ? 1 : 0,
    name: {
      first: userObj.name?.givenName,
      last: userObj.name?.familyName,
      fullName: userObj.name?.formatted,
      title: userObj.title
    },
    contact: {
      emailAddress: userObj.emails?.work?.value || userObj.emails?.undefined?.value,
      phoneNumber: userObj.phoneNumbers?.work?.value || userObj.phoneNumbers?.undefined?.value
    },
    group: defaultGroup
  }

  try {
    const response = await doRequest(baseEntity, method, path, body) // need to include ctx
    if (response.statusCode < 200 || response.statusCode > 299) {
      throw new Error(`${response.statusMessage} - ${JSON.stringify(response.body)}`)
    }
    return { id: response.body.id }
  } catch (err) {
    const newErr = new Error(`${action} error: ${err.message}`)
    if (newErr.message.includes("Validation problem, the value for 'logonName', 'Logon', already exists")) newErr.name = 'uniqueness'
    throw newErr
  }
}

// =================================================
// deleteUser
// =================================================
scimgateway.deleteUser = async (baseEntity, id, ctx) => {
  const action = 'deleteUser'
  scimgateway.logger.debug(`${pluginName}[${baseEntity}] handling "${action}" id=${id}`)

  const method = 'DELETE'
  const path = `/People/${id}`
  const body = null

  try {
    const response = await doRequest(baseEntity, method, path, body)
    if (response.statusCode < 200 || response.statusCode > 299) {
      throw new Error(`${response.statusMessage} - ${JSON.stringify(response.body)}`)
    }
    return null
  } catch (err) {
    throw new Error(`${action} error: ${err.message}`)
  }
}

// =================================================
// modifyUser
// - note that this gets user details first, and we can't differentiate between unset values and ""
// =================================================
scimgateway.modifyUser = async (baseEntity, id, attrObj, ctx) => {
  const action = 'modifyUser'
  scimgateway.logger.debug(`${pluginName}[${baseEntity}] handling "${action}" id=${id} attrObj=${JSON.stringify(attrObj)}`)

  const notValid = scimgateway.notValidAttributes(attrObj, validScimAttr)
  if (notValid) {
    throw new Error(`${action} error: unsupported scim attributes: ${notValid} (supporting only these attributes: ${validScimAttr.toString()})`)
  }

  let method, path, body
  if (attrObj.credProfile?.id) {
    method = 'POST'
    path = `/People/${id}/requests`
    body = {
      credProfile: attrObj.credProfile
    }
  } else {
    // note, empty strings are converted to undefined
    method = 'PATCH'
    path = `/People/${id}`
    body = {
      enabled: attrObj.active !== '' ? (attrObj.active ? 1 : 0) : undefined,
      name: {
        first: attrObj.name?.givenName || undefined,
        last: attrObj.name?.familyName || undefined,
        fullName: attrObj.name?.formatted || undefined,
        title: attrObj.title || undefined
      },
      contact: {
        emailAddress: attrObj.emails?.work?.value || attrObj.emails?.undefined?.value || undefined,
        phoneNumber: attrObj.phoneNumbers?.work?.value || attrObj.phoneNumbers?.undefined?.value || undefined
      }
    }
  }

  try {
    const response = await doRequest(baseEntity, method, path, body)
    if (response.statusCode < 200 || response.statusCode > 299) {
      throw new Error(`${response.statusMessage} - ${JSON.stringify(response.body)}`)
    }
    // unfortunately I can't update the returned data to include any details on the job created if credProfile was set
    // return cardRequest ? { job: { id: response.body.id } } : null
    return null
  } catch (err) {
    throw new Error(`${action} error: ${err.message}`)
  }
}

// =================================================
// getGroups
// =================================================
scimgateway.getGroups = async (baseEntity, getObj, attributes, ctx) => {
  //
  // "getObj" = { attribute: <>, operator: <>, value: <>, rawFilter: <>, startIndex: <>, count: <> }
  // rawFilter is always included when filtering
  // attribute, operator and value are included when requesting unique object or simpel filtering
  // See comments in the "mandatory if-else logic - start"
  //
  // "attributes" is array of attributes to be returned - if empty, all supported attributes should be returned
  // Should normally return all supported group attributes having id, displayName and members as mandatory
  // id and displayName are most often considered as "the same" having value = <GroupName>
  // Note, the value of returned 'id' will be used as 'id' in modifyGroup and deleteGroup
  // scimgateway will automatically filter response according to the attributes list
  //
  const action = 'getGroups'
  scimgateway.logger.debug(`${pluginName}[${baseEntity}] handling "${action}" getObj=${getObj ? JSON.stringify(getObj) : ''} attributes=${attributes}`)

  const method = 'GET'
  let path
  const body = null

  // mandatory if-else logic - start
  if (getObj.operator) {
    if (getObj.operator === 'eq' && ['id', 'displayName', 'externalId'].includes(getObj.attribute)) {
      // mandatory - unique filtering - single unique user to be returned - correspond to getUser() in versions < 4.x.x
      if (getObj.attribute === 'id') path = `/Groups/${getObj.value}?attributes=${attributes.join()}` // GET /Users/bjensen?attributes=
      else path = `/Groups?filter=${getObj.attribute} eq "${getObj.value}"${attributes.length > 0 ? '&attributes=' + attributes.join() : ''}` // GET /Users?filter=userName eq "bjensen"&attributes=userName,active,name.givenName,name.familyName,name.formatted,title,emails,phoneNumbers,entitlements
    } else if (getObj.operator === 'eq' && getObj.attribute === 'members.value') {
      // mandatory - return all groups the user 'id' (getObj.value) is member of - correspond to getGroupMembers() in versions < 4.x.x
      // Resources = [{ id: <id-group>> , displayName: <displayName-group>, members [{value: <id-user>}] }]
      path = `/Groups?filter=${getObj.attribute} eq "${getObj.value}"${attributes.length > 0 ? '&attributes=' + attributes.join() : ''}`
    } else {
      // optional - simpel filtering
      path = `/Groups?filter=${getObj.attribute} eq "${getObj.value}"${attributes.length > 0 ? '&attributes=' + attributes.join() : ''}`
    }
  } else if (getObj.rawFilter) {
    // optional - advanced filtering having and/or/not - use getObj.rawFilter
    throw new Error(`${action} error: not supporting advanced filtering: ${getObj.rawFilter}`)
  } else {
    // mandatory - no filtering (!getObj.operator && !getObj.rawFilter) - all groups to be returned - correspond to exploreGroups() in versions < 4.x.x
    path = `/Groups${attributes.length > 0 ? '?attributes=' + attributes.join() : ''}`
  }
  // mandatory if-else logic - end

  if (!path) throw new Error(`${action} error: mandatory if-else logic not fully implemented`)

  const ret = {
    // itemsPerPage will be set by scimgateway
    Resources: [],
    totalResults: null
  }

  try {
    const response = await doRequest(baseEntity, method, path, body)
    if (response.statusCode < 200 || response.statusCode > 299) {
      throw new Error(`${response.statusMessage} - ${JSON.stringify(response.body)}`)
    } else if (!response.body) {
      throw new Error('got empty response on REST request')
    }

    let responseArr = []
    if (Array.isArray(response.body.Resources)) responseArr = response.body.Resources
    else if (!response.body.Resources) {
      if (Array.isArray(response.body)) responseArr = response.body
      else if (typeof response.body === 'object' && Object.keys(response.body).length > 0) responseArr = [response.body]
    }

    if (!getObj.startIndex && !getObj.count) {
      // client request without paging
      getObj.startIndex = 1
      getObj.count = responseArr.length
    }

    for (let i = 0; i < responseArr.length && i + 1 - getObj.startIndex < getObj.count; ++i) {
      const groupObj = responseArr[i]
      if (!groupObj || Object.keys(groupObj).length < 1) continue

      const retObj = {
        // scimgateway strips attributes according to attributes list
        id: groupObj.id ? groupObj.id : undefined, // id and displayName is mandatory and most often set to the same value
        displayName: groupObj.displayName ? groupObj.displayName : undefined,
        members: Array.isArray(groupObj.members) ? groupObj.members : undefined
      }
      ret.Resources.push(retObj)
    }

    ret.totalResults = responseArr.length // not needed if client or endpoint do not support paging
    return ret
  } catch (err) {
    throw new Error(`${action} error: ${err.message}`)
  }
}

// =================================================
// createGroup
// =================================================
scimgateway.createGroup = async (baseEntity, groupObj, ctx) => {
  const action = 'createGroup'
  scimgateway.logger.debug(`${pluginName}[${baseEntity}] handling "${action}" groupObj=${JSON.stringify(groupObj)}`)

  const method = 'POST'
  const path = '/Groups'
  const body = { displayName: groupObj.displayName }

  try {
    const response = await doRequest(baseEntity, method, path, body)
    if (response.statusCode < 200 || response.statusCode > 299) {
      throw new Error(`${response.statusMessage} - ${JSON.stringify(response.body)}`)
    }
    return null
  } catch (err) {
    throw new Error(`${action} error: ${err.message}`)
  }
}

// =================================================
// deleteGroup
// =================================================
scimgateway.deleteGroup = async (baseEntity, id, ctx) => {
  const action = 'deleteGroup'
  scimgateway.logger.debug(`${pluginName}[${baseEntity}] handling "${action}" id=${id}`)

  const method = 'DELETE'
  const path = `/Groups/${id}`
  const body = null

  try {
    const response = await doRequest(baseEntity, method, path, body)
    if (response.statusCode < 200 || response.statusCode > 299) {
      throw new Error(`${response.statusMessage} - ${JSON.stringify(response.body)}`)
    }
    return null
  } catch (err) {
    throw new Error(`${action} error: ${err.message}`)
  }
}

// =================================================
// modifyGroup
// =================================================
scimgateway.modifyGroup = async (baseEntity, id, attrObj, ctx) => {
  const action = 'modifyGroup'
  scimgateway.logger.debug(`${pluginName}[${baseEntity}] handling "${action}" id=${id} attrObj=${JSON.stringify(attrObj)}`)

  if (!attrObj.members) {
    throw new Error(`${action} error: only supports modification of members`)
  }
  if (!Array.isArray(attrObj.members)) {
    throw new Error(`${action} error: ${JSON.stringify(attrObj)} - correct syntax is { "members": [...] }`)
  }

  let body = {}
  if (config.entity[baseEntity].scimVersion && config.entity[baseEntity].scimVersion === '1.1') {
    // scim v1.1 endpoint
    body = { members: [] }
    attrObj.members.forEach(function (el) {
      if (el.operation && el.operation === 'delete') {
        // delete member from group
        // PATCH = /Groups/Admins Body = {"members":[{"operation":"delete","value":"bjensen"}]}
        body.members.push({ operation: 'delete', value: el.value })
      } else {
        // add member to group/
        // PATCH = /Groups/Admins Body = {"members":[{"value":"bjensen"}]
        body.members.push({ value: el.value })
      }
    })
  } else {
    // scim 2.0 endpoint
    const addValues = []
    const removeValues = []
    attrObj.members.forEach(function (el) {
      if (el.operation && el.operation === 'delete') {
        // delete member from group
        removeValues.push({ value: el.value })
      } else {
        // add member to group/
        addValues.push({ value: el.value })
      }
    })
    if (addValues.length < 1 && removeValues.length < 1) return null
    body = { Operations: [] }
    if (addValues.length > 0) {
      body.Operations.push({
        op: 'add',
        path: 'members',
        value: addValues
      })
    }
    if (removeValues.length > 0) {
      body.Operations.push({
        op: 'remove',
        path: 'members',
        value: removeValues
      })
    }
  }

  const method = 'PATCH'
  const path = `/Groups/${id}`

  try {
    const response = await doRequest(baseEntity, method, path, body)
    if (response.statusCode < 200 || response.statusCode > 299) {
      throw new Error(`${response.statusMessage} - ${JSON.stringify(response.body)}`)
    }
    return null
  } catch (err) {
    throw new Error(`${action} error: ${err.message}`)
  }
}

// =================================================
// helpers
// =================================================

//
// getServiceClient - returns options needed for connection parameters
//
//   path = e.g. "/xxx/yyy", then using host/port/protocol based on config baseUrls[0]
//          auth automatically added and failover according to baseUrls array
//
//   path = url e.g. "http(s)://<host>:<port>/xxx/yyy", then using the url host/port/protocol
//          opt (options) may be needed e.g {auth: {username: "username", password: "password"} }
//
const getServiceClient = async (baseEntity, method, path, opt) => {
  const action = 'getServiceClient'

  let urlObj
  if (!path) path = ''
  try {
    urlObj = new URL(path)
  } catch (err) {
    //
    // path (no url) - default approach and client will be cached based on config
    //
    if (_serviceClient[baseEntity]) {
      // serviceClient already exist
      scimgateway.logger.debug(`${pluginName}[${baseEntity}] ${action}: Using existing client`)
    } else {
      scimgateway.logger.debug(`${pluginName}[${baseEntity}] ${action}: Client have to be created`)
      let client = null
      if (config.entity && config.entity[baseEntity]) client = config.entity[baseEntity]
      if (!client) {
        throw new Error(`Base URL have baseEntity=${baseEntity}, and configuration file ${pluginName}.json is missing required baseEntity configuration for ${baseEntity}`)
      }

      urlObj = new URL(config.entity[baseEntity].baseUrls[0])
      const param = {
        baseUrl: config.entity[baseEntity].baseUrls[0],
        options: {
          json: true, // json-object response instead of string
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Basic ' + Buffer.from(`${config.entity[baseEntity].username}:${scimgateway.getPassword(`endpoint.entity.${baseEntity}.password`, configFile)}`).toString('base64')
          },
          host: urlObj.hostname,
          port: urlObj.port, // null if https and 443 defined in url
          protocol: urlObj.protocol, // http: or https:
          rejectUnauthorized: false // accepts self-siged certificates
          // 'method' and 'path' added at the end
        }
      }

      // proxy
      if (config.entity[baseEntity].proxy && config.entity[baseEntity].proxy.host) {
        const agent = new HttpsProxyAgent(config.entity[baseEntity].proxy.host)
        param.options.agent = agent // proxy
        if (config.entity[baseEntity].proxy.username && config.entity[baseEntity].proxy.password) {
          param.options.headers['Proxy-Authorization'] = 'Basic ' + Buffer.from(`${config.entity[baseEntity].proxy.username}:${scimgateway.getPassword(`endpoint.entity.${baseEntity}.proxy.password`, configFile)}`).toString('base64') // using proxy with auth
        }
      }

      if (!_serviceClient[baseEntity]) _serviceClient[baseEntity] = {}
      _serviceClient[baseEntity] = param // serviceClient created
    }

    const cli = scimgateway.copyObj(_serviceClient[baseEntity]) // client ready

    // failover support
    path = _serviceClient[baseEntity].baseUrl + path
    urlObj = new URL(path)
    cli.options.host = urlObj.hostname
    cli.options.port = urlObj.port
    cli.options.protocol = urlObj.protocol

    // adding none static
    cli.options.method = method
    cli.options.path = `${urlObj.pathname}${urlObj.search}`
    if (opt) cli.options = scimgateway.extendObj(cli.options, opt) // merge with argument options

    return cli // final client
  }
  //
  // url path - none config based and used as is (no cache)
  //
  scimgateway.logger.debug(`${pluginName}[${baseEntity}] ${action}: Using none config based client`)
  let options = {
    json: true,
    headers: {
      'Content-Type': 'application/json'
    },
    host: urlObj.hostname,
    port: urlObj.port,
    protocol: urlObj.protocol,
    method: method,
    path: urlObj.pathname
  }

  // proxy
  if (config.entity[baseEntity].proxy && config.entity[baseEntity].proxy.host) {
    const agent = new HttpsProxyAgent(config.entity[baseEntity].proxy.host)
    options.agent = agent // proxy
    if (config.entity[baseEntity].proxy.username && config.entity[baseEntity].proxy.password) {
      options.headers['Proxy-Authorization'] = 'Basic ' + Buffer.from(`${config.entity[baseEntity].proxy.username}:${scimgateway.getPassword(`endpoint.entity.${baseEntity}.proxy.password`, configFile)}`).toString('base64') // using proxy with auth
    }
  }

  // merge any argument options - support basic auth using {auth: {username: "username", password: "password"} }
  if (opt) {
    const o = scimgateway.copyObj(opt)
    if (o.auth) {
      options.headers.Authorization = 'Basic ' + Buffer.from(`${o.auth.username}:${o.auth.password}`).toString('base64')
      delete o.auth
    }
    options = scimgateway.extendObj(options, o)
  }

  const cli = {}
  cli.options = options
  return cli // final client
}

const updateServiceClient = (baseEntity, obj) => {
  if (_serviceClient[baseEntity]) _serviceClient[baseEntity] = scimgateway.extendObj(_serviceClient[baseEntity], obj) // merge with argument options
}

//
// doRequest - execute REST service
//
const doRequest = async (baseEntity, method, path, body, opt, retryCount) => {
  try {
    const cli = await getServiceClient(baseEntity, method, path, opt)
    const options = cli.options
    const result = await new Promise((resolve, reject) => {
      let dataString = ''
      if (body) {
        if (options.headers['Content-Type'].toLowerCase() === 'application/x-www-form-urlencoded') {
          if (typeof data === 'string') dataString = body
          else dataString = querystring.stringify(body) // JSON to query string syntax + URL encoded
        } else dataString = JSON.stringify(body)
        options.headers['Content-Length'] = Buffer.byteLength(dataString, 'utf8')
      }

      const reqType = options.protocol.toLowerCase() === 'https:' ? https.request : http.request
      const req = reqType(options, (res) => {
        const { statusCode, statusMessage } = res // solving parallel problem (const + don't use res.statusCode)

        let responseString = ''
        res.setEncoding('utf-8')

        res.on('data', (chunk) => {
          responseString += chunk
        })

        res.on('end', () => {
          const response = {
            statusCode: statusCode,
            statusMessage: statusMessage,
            body: null
          }
          try {
            if (responseString) response.body = JSON.parse(responseString)
          } catch (err) {
            response.body = responseString
          }
          if (statusCode < 200 || statusCode > 299) reject(new Error(JSON.stringify(response)))
          resolve(response)
        })
      }) // req

      req.on('socket', (socket) => {
        socket.setTimeout(60000) // connect and wait timeout => socket hang up
        socket.on('timeout', function () {
          req.abort()
        })
      })

      req.on('error', (error) => {
        // also catching req.abort
        req.end()
        reject(error)
      })

      if (dataString) req.write(dataString)
      req.end()
    }) // Promise

    scimgateway.logger.debug(`${pluginName}[${baseEntity}] doRequest ${method} ${options.protocol}//${options.host}${options.port ? `:${options.port}` : ''}${path} Body = ${JSON.stringify(body)} Response = ${JSON.stringify(result)}`)
    return result
  } catch (err) {
    // includes failover/retry logic based on config baseUrls array
    scimgateway.logger.error(`${pluginName}[${baseEntity}] doRequest ${method} ${path} Body = ${JSON.stringify(body)} Error Response = ${err.message}`)
    if (!retryCount) retryCount = 0
    let urlObj
    try {
      urlObj = new URL(path)
    } catch (err) {}
    if (!urlObj && (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND')) {
      if (retryCount < config.entity[baseEntity].baseUrls.length) {
        retryCount++
        updateServiceClient(baseEntity, { baseUrl: config.entity[baseEntity].baseUrls[retryCount - 1] })
        scimgateway.logger.debug(`${pluginName}[${baseEntity}] ${config.entity[baseEntity].baseUrls.length > 1 ? 'failover ' : ''}retry[${retryCount}] using baseUrl = ${_serviceClient[baseEntity].baseUrl}`)
        const ret = await doRequest(baseEntity, method, path, body, opt, retryCount) // retry
        return ret // problem fixed
      } else {
        const newerr = new Error(err.message)
        newerr.message = newerr.message.replace('ECONNREFUSED', 'UnableConnectingService') // avoid returning ECONNREFUSED error
        newerr.message = newerr.message.replace('ENOTFOUND', 'UnableConnectingHost') // avoid returning ENOTFOUND error
        throw newerr
      }
    } else throw err // CA IM retries getUsers failure once (retry 6 times on ECONNREFUSED)
  }
} // doRequest

//
// Cleanup on exit
//
process.on('SIGTERM', () => {
  // kill
})
process.on('SIGINT', () => {
  // Ctrl+C
})
