import { Dependencies, Injectable, Logger } from '@nestjs/common'
import { createClient as createMatrixClient } from 'matrix-js-sdk'
import { ConfigService } from '@nestjs/config'
import * as _ from 'lodash'
import { Interval } from '@nestjs/schedule'
import { HttpService } from '@nestjs/axios'
import Handlebars from 'handlebars'
import fs from 'fs'
import { join } from 'path'
import locationData from '../data/locationData.json'

@Injectable()
@Dependencies(ConfigService, HttpService)
export class StudentprojectService {
  constructor (configService, httpService) {
    this.configService = configService
    this.httpService = httpService
    this.studentprojects = {}
  }

  @Interval(60 * 60 * 1000) // Call this every 20 minutes
  async fetch () {
    Logger.log('Fetching student projects...')

    const result = {}

    const configService = this.configService
    const httpService = this.httpService

    const matrixClient = createMatrixClient({
      baseUrl: this.configService.get('matrix.homeserver_base_url'),
      accessToken: this.configService.get('matrix.access_token'),
      userId: this.configService.get('matrix.user_id'),
      useAuthorizationHeader: true
    })

    function createSpaceObject (matrixClient, id, name, metaEvent, thumbnail, authors, credit, published, topicEn, topicDe, events, parent, parentSpaceId) { // changed
      return {
        id: id,
        name: name,
        type: metaEvent.content.type,
        topicEn: topicEn,
        topicDe: topicDe,
        events: events,
        thumbnail: thumbnail ? matrixClient.mxcUrlToHttp(thumbnail, 800, 800, 'scale') : '',
        thumbnail_full_size: thumbnail ? matrixClient.mxcUrlToHttp(thumbnail) : '',
        authors: authors,
        credit: credit,
        published: published,
        parent: parent,
        parentSpaceId: parentSpaceId,
        children: {}
      }
    }

    // The types of spaces we want to scan for studentprojects
    const typesOfSpaces = ['context',
      'class',
      'course',
      'institution',
      'degree program',
      'design department',
      'faculty',
      'institute',
      'semester']

    async function scanForAndAddSpaceChildren (spaceId, path, parent, parentSpaceId) {
      const stateEvents = await matrixClient.roomState(spaceId).catch(() => {})

      const metaEvent = _.find(stateEvents, { type: 'dev.medienhaus.meta' })
      if (!metaEvent) return

      const nameEvent = _.find(stateEvents, { type: 'm.room.name' })
      if (!nameEvent) return

      // const topicEvent = _.find(stateEvents, { type: 'm.room.topic' })
      const joinRulesEvent = _.find(stateEvents, { type: 'm.room.join_rules' })

      const spaceName = nameEvent.content.name

      if (metaEvent.content.deleted) return

      // robert
      const avatar = _.find(stateEvents, { type: 'm.room.avatar' })

      let credit = ''
      let published = ''
      if (metaEvent.content.credit && metaEvent.content.credit.length > 0) {
        credit = metaEvent.content.credit
      }

      if (metaEvent.content.published) {
        published = metaEvent.content.published
      } else {
        const joinRule = _.find(stateEvents, { type: 'm.room.join_rules' })

        published = joinRule.join_rule === 'invite' ? 'draft' : 'public'
      }
      if (metaEvent.content.deleted) {
        published = 'deleated'
      }

      // robert end

      if (
        metaEvent.content.type === 'studentproject' &&
        (metaEvent.content.published ? metaEvent.content.published === 'public' : (joinRulesEvent && joinRulesEvent.content.join_rule === 'public'))
      ) {
        const hierarchy = await matrixClient.getRoomHierarchy(spaceId, 50, 10)
        // fetch descriptions
        const en = hierarchy.rooms.filter(room => room.name === 'en')
        const topicEn = en[0].topic || undefined
        const de = hierarchy.rooms.filter(room => room.name === 'de')
        const topicDe = de[0].topic || undefined
        // fetch authors aka. collaborators
        const joinedMembers = await matrixClient.getJoinedRoomMembers(spaceId)
        const authorNames = []
        for (const [key, value] of Object.entries(joinedMembers.joined)) {
          authorNames.push(value.display_name)
        }
        // fetch location
        const req = {
          method: 'GET',
          headers: { Authorization: 'Bearer ' + configService.get('matrix.access_token') }
        }
        const events = hierarchy.rooms.filter(room => room.name === 'events' && !room.name.startsWith('x_'))
        // const location = hierarchy.rooms.filter(room => room.name.includes('location') && !room.name.startsWith('x_'))
        const eventResult = [] // array for events
        if (events.length > 0) {
          const eventHierarchy = await matrixClient.getRoomHierarchy(events[0].room_id, 50, 1)

          async function fetchContent (roomId) {
            const result = await httpService.axiosRef(configService.get('matrix.homeserver_base_url') + `/_matrix/client/r0/rooms/${roomId}/messages?limit=99&dir=b`, req)
            const data = result.data
            const htmlString = data.chunk.map(type => {
              if (type.type === 'm.room.message' && type.content['m.new_content'] === undefined && type.redacted_because === undefined) {
                return type.content.body
              } else { return null }
            }
            ).filter(x => x !== null)
            return htmlString
          }
          // @TODO one map too many
          await Promise.all(eventHierarchy.rooms.map(async (event, index) => {
            if (index === 0) return // we ignore the first result since its the event space itself
            if (event.children_state.length > 0) { // if the space has children
              const childrenResult = await Promise.all(event.children_state.map(async child => {
                const childrenHierarchy = await matrixClient.getRoomHierarchy(child.state_key, 50, 10)
                return (await Promise.all(childrenHierarchy.rooms.map(async (data, index) => {
                  // we want to return an array of object with all information for the specific event
                  const content = await fetchContent(data.room_id)
                  return { name: data.name.substring(data.name.indexOf('_') + 1), content: content }
                })))[0]
              }))
              eventResult.push(childrenResult)
            } else { // otherwise we direcetly get the content of the room
              const content = await fetchContent(event.room_id)
              eventResult.push([{ name: event.name.substring(event.name.indexOf('_') + 1), content: content }])
            }
          }))
        }

        // fetch events

        _.set(result, [spaceId], createSpaceObject(matrixClient, spaceId, spaceName, metaEvent, avatar?.content.url, authorNames, credit, published, topicEn, topicDe, eventResult, parent, parentSpaceId))
      } else {
        if (!typesOfSpaces.includes(metaEvent.content.type)) return
      }

      // _.set(result, [...path, spaceId], createSpaceObject(spaceId, spaceName, metaEvent))

      // console.log(`getting children for ${spaceId} / ${spaceName}`)

      for (const event of stateEvents) {
        if (event.type !== 'm.space.child') continue
        if (event.room_id !== spaceId) continue
        // if (event.sender !== matrixClient.getUserId()) continue

        await scanForAndAddSpaceChildren(event.state_key, [...path, spaceId, 'children'], spaceName, spaceId)
      }
    }

    await scanForAndAddSpaceChildren(this.configService.get('matrix.root_context_space_id'), [], '', null)

    this.studentprojects = result

    Logger.log(`Found ${Object.keys(result).length} student projects`)
  }

  getAll () {
    return this.studentprojects
  }

  getAllEvents () {
    const events = {}
    Object.entries(this.studentprojects).forEach(([k, c]) => {
      if (c.events && c.events.length > 0) {
        events[k] = c
      }
    })
    return events
  }

  getAllEventsByDay () {
    const days = {}
    const events = this.getAllEvents()

    Object.entries(events).forEach(([k, c]) => {
      if (c.events && c.events.length > 0) {
        // events[k] = c
        c.events.forEach(event => {
          event.forEach(entry => {
            if (entry.name === 'date') {
              entry.content.forEach(date => {
                if (date.split(' ')[0] in days) {
                } else {
                  days[date.split(' ')[0]] = {}
                }
                days[date.split(' ')[0]][k] = {
                  id: c.id,
                  name: c.name,
                  parent: c.parent,
                  type: c.type
                }
              })
            }
          })
        })
        c.events.forEach(event => {
          const tempData = {}
          tempData.id = c.id
          tempData.event = event
          const infos = this.getEventInformation(tempData)
          if (infos.date) {
            infos.date.forEach(date => {
              Object.entries(days).forEach(([infoK, infoC]) => {
                if (infoK === date.day) {
                  Object.entries(infoC).forEach(([eventK, eventC]) => {
                    if (eventC.id === infos.id) {
                      days[infoK][eventK] = { ...eventC, ...infos }
                    }
                  })
                }
              })
            })
          }
        })
      }
    })
    return days
  }

  getEventInformation (event) {
    const data = {}
    data.id = event.id
    event.event.forEach(entry => {
      entry.content.forEach(content => {
        if (entry.name === 'location') {
          if (data.coordinates) {
            data.coordinates.push(content)
          } else {
            data.coordinates = []
            data.coordinates.push(content)
          }
          this.coordiantesToLocation(content.split('-')[0])
          if (data.locations) {
            data.locations.push(this.coordiantesToLocation(content))
          } else {
            data.locations = []
            data.locations.push(this.coordiantesToLocation(content))
          }
        }
        if (entry.name === 'date') {
          if (data.date) {
            data.date.push({ day: content.split(' ')[0], time: content.split(' ')[1] })
          } else {
            data.date = []
            data.date.push({ day: content.split(' ')[0], time: content.split(' ')[1] })
          }
        }
        if (entry.name === 'bbb') {
          if (data.bigBlueButton) {
            data.bigBlueButton.push(content)
          } else {
            data.bigBlueButton = []
            data.bigBlueButton.push(content)
          }
        }
        if (entry.name === 'livestream') {
          if (data.livestream) {
            data.livestream.push(content)
          } else {
            data.livestream = []
            data.livestream.push(content)
          }
        }
      })
    })

    return data
  }

  coordiantesToLocation (coords) {
    const found = locationData.find(location => location.coordinates.trim() === coords.split('-')[0].trim())
    if (found && coords.split('-')[1]) {
      found.room = coords.split('-')[1]
    }
    return found
  }

  findId (mainId, tree, flat) {
    let ret
    Object.entries(tree).forEach(([k, c]) => {
      const branch = this.searchLevel(mainId.id, { [k]: c }, {})
      if (flat) {
        const flatTree = this.flattenTree({ treeSection: branch, flattened: [] })
        if (flatTree && flatTree.flattened) {
          ret = flatTree.flattened
        }
      } else {
        ret = branch
      }
    })
    return ret
  }

  flattenTree (data) {
    Object.entries(data.treeSection).forEach(([k, c]) => {
      const tmp = { id: c.id }
      data.flattened.push(tmp)
      data.treeSection = c.child
      if (data.treeSection) {
        this.flattenTree(data)
      }
    })
    return data
  }

  searchLevel (id, level, parent) {
    let ret
    Object.entries(level).forEach(([k, c]) => {
      if (k === id) {
        ret = { [parent]: { id: parent, child: { [id]: { id: id } } } }
      } else {
        if (c.children && Object.keys(c.children).length > 0) {
          Object.entries(c.children).forEach(([childK, childC]) => {
            const r = this.searchLevel(id, { [childK]: childC }, k)
            if (r) {
              if (parent && Object.keys(parent).length > 0) {
                ret = { [parent]: { id: parent, child: r } }
              } else {
                ret = r
              }
            }
          })
        }
      }
    })
    return (ret)
  }

  getByContextSpaceIds (contextSpaceIds) {
    return _.filter(this.studentprojects, project => contextSpaceIds.includes(project.parentSpaceId))
  }

  async get (id, language = 'en') {
    const { content, formattedContent } = await this.getContent(id, language)
    return { ...this.studentprojects[id], content, formatted_content: formattedContent }
  }

  async getContent (projectSpaceId, language) {
    const contentBlocks = await this.getContentBlocks(projectSpaceId, language)

    return {
      content: contentBlocks,
      formattedContent: Object.keys(contentBlocks).map(index => contentBlocks[index].formatted_content).join('')
    }
  }

  async getContentBlocks (projectSpaceId, language) {
    const result = {}
    const matrixClient = createMatrixClient({
      baseUrl: this.configService.get('matrix.homeserver_base_url'),
      accessToken: this.configService.get('matrix.access_token'),
      userId: this.configService.get('matrix.user_id'),
      useAuthorizationHeader: true
    })

    // Get the spaces for the available languages
    const languageSpaces = {}
    const spaceSummary = await matrixClient.getSpaceSummary(projectSpaceId, 0)
    spaceSummary.rooms.map(languageSpace => {
      if (languageSpace.room_id == projectSpaceId) return
      languageSpaces[languageSpace.name] = languageSpace.room_id
    })

    // Get the actual content block rooms for the given language
    const contentRooms = await matrixClient.getSpaceSummary(languageSpaces[language], 0)

    await Promise.all(contentRooms.rooms.map(async (contentRoom) => {
      // Skip the language space itself
      if (contentRoom.room_id === languageSpaces[language]) return

      // Get the last message of the current content room
      const lastMessage = (await this.httpService.axiosRef(this.configService.get('matrix.homeserver_base_url') + `/_matrix/client/r0/rooms/${contentRoom.room_id}/messages`, {
        method: 'GET',
        headers: { Authorization: 'Bearer ' + this.configService.get('matrix.access_token') },
        params: {
          // @TODO Skip deleted messages
          limit: 1,
          dir: 'b',
          // Only consider m.room.message events
          filter: JSON.stringify({ types: ['m.room.message'] })
        }
      })).data.chunk[0]

      if (!lastMessage) return

      const type = contentRoom.name.substring(contentRoom.name.indexOf('_') + 1)
      const content = (() => {
        switch (type) {
          case 'audio':
          case 'image':
            return matrixClient.mxcUrlToHttp(lastMessage.content.url)
          default: return lastMessage.content.body
        }
      })()
      const formattedContent = (() => {
        switch (type) {
          // For text, ul and ol we just return whatever's stored in the Matrix event's formatted_body
          case 'text':
          case 'ul':
          case 'ol':
            return lastMessage.content.formatted_body
          // For all other types we render the HTML using the corresponding Handlebars template in /views/contentBlocks
          default: return Handlebars.compile(fs.readFileSync(join(__dirname, '..', 'views', 'contentBlocks', `${type}.hbs`), 'utf8'))({
            content,
            matrixEventContent: lastMessage.content
          })
        }
      })()

      // Append this content block's data to our result set
      result[contentRoom.name.substring(0, contentRoom.name.indexOf('_'))] = {
        type,
        content,
        formatted_content: formattedContent
      }
    }))

    return result
  }
}
