const debug = require('debug')('matrix-puppet:slack:client');
const Promise = require('bluebird');
const EventEmitter = require('events').EventEmitter;
const { WebClient, RtmClient, CLIENT_EVENTS } = require('@slack/client');
const { download } = require('./utils');
const fs = require('fs');
const stream = require('stream');

class Client extends EventEmitter {
  constructor(token) {
    super();
    this.token = token;
    this.rtm = null;
    this.web = null;
    this.data = {
      self: {},
      channels: [],
      users: [],
    }
  }
  connect() {
    return new Promise((resolve, reject) => {
      this.rtm = new RtmClient(this.token);

      // reject on any unrecoverable error
      this.rtm.on(CLIENT_EVENTS.RTM.UNABLE_TO_RTM_START, (err) => {
        this.emit('unable-to-start', err);
        reject(err);
      });

      // disconnect is called only when there is on chance of reconnection,
      // either due to unrecoverable errors or the disabling of reconnect
      // so it's the best way to know to act towards reconnecting
      // the issue here is that at this point we dont know if
      // its an "unrecoverable error" or not, so if we were to implement
      // reconnect ourself in respones to this event, we may start looping
      this.rtm.on(CLIENT_EVENTS.RTM.DISCONNECT, () => {
        this.emit('disconnected'); // can use this to announce status and issue a reconnect
      });

      this.rtm.on(CLIENT_EVENTS.RTM.AUTHENTICATED, (rtmStartData) => {
        this.web = new WebClient(this.token);
        debug(`Logged in as ${rtmStartData.self.name} of team ${rtmStartData.team.name}`);
        if (process.env.DEBUG) {
          const f = `data-${rtmStartData.team.name}.json`;
          debug(`DEBUG environment variable is on. writing data dump file for your perusal: ${f}`);
          require('fs').writeFileSync(f, JSON.stringify(rtmStartData, null, 2));
        }
        this.data = rtmStartData;
        this.data.channels = this.data.channels
          .concat(this.data.groups) // we want the hidden channels, "groups", too!
          .concat(this.data.ims); // also we want the im channels, "ims"
      });

      // you need to wait for the client to fully connect before you can send messages
      this.rtm.on(CLIENT_EVENTS.RTM.RTM_CONNECTION_OPENED, () => {
        this.emit('connected'); // can use this to announce status
        resolve();
      });

      this.rtm.on(CLIENT_EVENTS.RTM.RAW_MESSAGE, (payload) => {
        let data = JSON.parse(payload);
        //console.log(data);
        switch (data.type) {
          case 'message':
            debug('emitting message:', data);
            this.emit('message', data);
            break;
          case 'channel_joined':
          case 'group_joined':
          case 'mpim_joined':
          case 'im_created':
            {
              const chan = this.getChannelById(data.channel.id);
              if (!chan) {
                this.data.channels.push(data.channel);
              }
            }
            break;
          case 'channel_rename':
          case 'group_rename':
            {
              let chan = this.getChannelById(data.channel.id);
              if (!chan) {
                this.data.channels.push(data.channel);
                chan = data.channel;
              }
              if (chan.name !== data.channel.name) {
                chan.name = data.channel.name;
              }
            }
            break;
          case 'team_join':
            this.data.users.push(data.user);
            break;
          case 'user_change':
            if (!data.user) {
                debug('something weird with user_change: ', data);
            } else {
              let found = false;
              for (let i = 0; i < this.data.users.length; i++) {
                if (!this.data.users[i]) {
                  continue;
                }
                if (this.data.users[i].id == data.user.id) {
                  this.data.users[i] = data.user;
                  found = true;
                  break;
                }
              }
              if (!found) {
                this.data.users.push(data.user);
              }
            }
            break;
          case 'user_typing':
            debug('emitting typing message:', data);
            this.emit('typing', data);
            break;
          case 'bot_added':
          case 'bot_changed':
            {
              let found = false;
              for (let i = 0; i < this.data.bots.length; i++) {
                if (this.data.bots[i].id == data.bot.id) {
                  this.data.bots[i] = data.bot;
                  found = true;
                  break;
                }
              }
              if (!found) {
                this.data.bots.push(data.bot);
              }
            }
            break;
          case 'reconnect_url':
          case 'pong':
            // ignore
            break;
          default:
            debug('raw message, type:', data.type);
            break;
        }
      });

      this.rtm.start();
    });
  }
  getSelfUserId() {
    return this.data.self.id;
  }
  /**
   * Finds a bot by ID
   *
   * @returns {object} a bot:
   * {
   *   "id": "B03RKF7LP",
   *   "deleted": false,
   *   "name": "gdrive",
   *   "app_id": "A0F7YS32P",
   *   "icons": {
   *     "image_36": "https://a.slack-edge.com/12b5a/plugins/gdrive/assets/service_36.png",
   *     "image_48": "https://a.slack-edge.com/12b5a/plugins/gdrive/assets/service_48.png",
   *     "image_72": "https://a.slack-edge.com/12b5a/plugins/gdrive/assets/service_72.png"
   *   }
   * }
   **/
  getBotById(id) {
    // Get unknown bots from Slack
    return new Promise((resolve, reject) => {
        let bot = this.data.bots.find(u => u.id === id);
        if (bot) {
            resolve(bot);
        } else {
            return this.web.bots.info(id)
                .then((res) => {
                    this.data.bots.push(res.bot);
                    resolve(res.bot);
                }).catch((err) => {
                    reject(err);
                });
        }
    });
  }
  getUserById(id) {
    // Get unknown users from Slack
    return new Promise((resolve, reject) => {
        let user = this.data.users.find(u => u.id === id);
        if (user) {
            resolve(user);
        } else {
            return this.web.users.info(id)
                .then((res) => {
                    this.data.users.push(res.user);
                    resolve(res.user);
                }).catch((err) => {
                    reject(err);
                });
        }
    });
  }
  getChannelById(id) {
    // Get unknown channels from Slack
    return new Promise((resolve, reject) => {
        let channel = this.data.channels.find(c => c.id === id);
        if (channel) {
            resolve(channel);
        } else {
            return this.web.channels.info(id)
                .then((res) => {
                    this.data.channels.push(res.channel);
                    resolve(res.channel);
                }).catch((err) => {
                    reject(err);
                });
        }
    });
  }
  getConversationById(id) {
    // Get unknown conversations from Slack
    return new Promise((resolve, reject) => {
        let chan = this.data.channels.find(c => c.id === id);
        if (chan) {
            if (chan.is_im === undefined) {
                chan.is_im = false;
            }
            if (chan.isDirect === undefined) {
                chan.isDirect = chan.is_im;
            }
            resolve(chan);
        } else {
            let im = this.data.ims.find(c => c.id === id);
            if (im) {
                if (im.is_im === undefined) {
                    im.is_im = true;
                }
                if (im.isDirect === undefined) {
                    im.isDirect = im.is_im;
                }
                resolve(im);
            } else {
                return this.web.conversations.info(id)
                    .then((res) => {
                        if (res.channel.isDirect === undefined) {
                            res.channel.isDirect = res.channel.is_im;
                        }
                        if (res.channel.is_im) {
                            this.data.ims.push(res.channel);
                        } else {
                            this.data.channels.push(res.channel);
                        }
                        return res.channel;
                    }).catch((err) => {
                        reject(err);
                    });
            }
        }
    });
  }
  // get "room" by id will check for channel or IM and hide the details of that difference
  // but pass that detail along in case the callee cares.
  getRoomById(id) {
    return this.getConversationById(id)
      .then((res) => {
          return res;
      }).catch((err) => {
          console.log(err);
          return err;
      });
  }
  sendMessage(text, channel) {
    return this.rtm.sendMessage(text, channel);
  }
  getUsers() {
    return this.data.users;
  }
  getChannels() {
    return this.data.channels;
  }
  /**
   * Posts an image to the slack channel.
   * You cannot do this with the RTM api, so we
   * use the slack web api for this.
   *
   * Attachments are pretty cool, check it here:
   * https://api.slack.com/docs/messages/builder
   */
  sendImageMessage(imageUrl, title, channel) {
    return this.sendFileMessage(imageUrl, title, title, channel);
  }
  sendFileMessage(fileUrl, title, filename, channel) {
    return new Promise((resolve, reject) => {
      download.getBufferAndType(fileUrl).then(({ buffer }) => {
        const opts = {
          file: buffer,
          title: title,
          filetype: 'auto',
          channels: channel,
        };

        return this.web.files.upload(filename, opts, (err, res) => {
          err ? reject(err) : resolve(res);
        });
      }).catch((err) => {
        console.log(err);
      });
    });
  }
  downloadMatrixFile(url) {
    return ;
  }
  downloadImage(url) {
    return download.getBufferAndType(url, {
      headers: { Authorization: 'Bearer ' +  this.token}
    });
  }
  openIm(user) {
    console.log('getting im for ' + user);
    return this.web.im.open(user);
  }
}

module.exports = Client;
