const debug = require('debug')('matrix-puppet:slack:app');
const { MatrixPuppetBridgeBase } = require("matrix-puppet-bridge");
const config = require('./config.json');
const SlackClient = require('./client');
const slackdown = require('./slackdown');
const mxtoslack = require('./mxtoslack');
const showdown  = require('showdown');
const emojione = require('emojione')
const converter = new showdown.Converter({
  literalMidWordUnderscores : true,
  simpleLineBreaks: true,
  strikethrough: true,
  omitExtraWLInCodeBlocks: true
});

class App extends MatrixPuppetBridgeBase {
  setSlackTeam(teamName, userAccessToken, notify) {
    this.teamName = teamName;
    this.userAccessToken = userAccessToken;
    this.slackPrefix = 'slack';
    this.servicePrefix = `${this.slackPrefix}_${this.teamName}`;
    this.notifyToSlack = notify;
  }
  getServiceName() {
    return "Slack";
  }
  getServicePrefix() {
    return this.servicePrefix;
  }
  sendStatus(_msg) {
    let msg = `${this.teamName}: ${_msg}`
    this.sendStatusMsg({
      fixedWidthOutput: false,
      roomAliasLocalPart: `${this.slackPrefix}_${this.getStatusRoomPostfix()}`
    }, msg).catch((err)=>{
      console.log(err);
    });
  }
  initThirdPartyClient() {
    this.client = new SlackClient(this.userAccessToken);
    this.client.on('unable-to-start', (err)=>{
      this.sendStatus(`unable to start: ${err.message}`);
    });
    this.client.on('disconnected', ()=>{
      this.sendStatus('disconnected. will try to reconnect in a minute...');
      setTimeout(()=> {
        this.initThirdPartyClient().catch((err)=>{
          debug('reconnect failed with error', err.message);
          this.sendStatus('reconnnect failed with error', err.message);
        })
      }, 60 * 1000);
    });
    this.client.on('connected', (err)=>{
      this.sendStatus(`connected`);
    });
    return this.client.connect().then(()=>{
      debug('waiting a little bit for initial self-messages to fire before listening for messages');
      setTimeout(()=>this.registerMessageListener(), 5000);
    })
  }
  registerMessageListener() {
    this.client.on('user_typing', (data)=>{
        if (data.channel && data.user) {
            this.sendTyping(data, true);
        } else {
            debug('Not sending typing event', data);
        }
    });
    this.client.on('message', (data)=>{
      if (data.subtype === "message_changed") {
        if (data.message.text === data.previous_message.text) {
          // do nothing
          debug('ignoring duplicate edit', data);
        } else {
          this.createAndSendPayload({
            channel: data.channel,
            text: `Edit: ${data.message.text}`,
            user: data.message.user
          });
        }
      } else if (data.subtype === 'message_deleted') {
        this.createAndSendPayload({
          channel: data.channel,
          text: `Deleted: ${data.previous_message.text}`,
          user: 'USLACKBOT', // message_deleted doesn't contain message.user
        });
      } else if (data.subtype === 'message_replied') {
          // do nothing
          debug('ignoring message replied event', data);
      } else {
        if (data.files && data.files.length > 0) {
          for (let i = 0; i < data.files.length; i++) {
            debug('file round: ', i)
            data.file = data.files[i];
            this.sendFile(data).then(() => {
              if (data.text != '') {
                this.createAndSendPayload({
                  channel: data.channel,
                  text: data.text,
                  attachments: data.attachments,
                  bot_id: data.bot_id,
                  user: data.user,
                  user_profile: data.user_profile,
                });
              }
            });
          }
        } else {
          this.createAndSendPayload({
            channel: data.channel,
            text: data.text,
            attachments: data.attachments,
            bot_id: data.bot_id,
            user: data.user,
            user_profile: data.user_profile,
          });
        }
      }
    });
    debug('registered message listener');
  }
  sendTyping(data, isTyping) {
      const { channel, user } = data;
      if (user && user === this.client.getSelfUserId()) {
        return new Promise((resolve, reject)=>{
            resolve();
        });
      }
      return this.getOrCreateMatrixRoomFromThirdPartyRoomId(channel).then((roomId) => {
          return this.getIntentFromThirdPartySenderId(user).then((intent) => {
              return intent.sendTyping(roomId, isTyping).then(() => {
                  if (typeof this.typing === 'undefined') {
                      this.typing = [];
                  }
                  var index;
                  if (isTyping && this.typing.indexOf(channel+user)) {
                      this.typing.push(channel+user);
                  } else if (!isTyping && (index = this.typing.indexOf(channel+user)) > -1) {
                      this.typing = this.typing.slice(index);
                  }
              }).catch((err) => {
                  debug('failed to send typing event', err);
              });
          }).catch((err) => {
              debug('failed to get intent', err);
          })
      }).catch((err) => {
          debug(err);
      });
  }
  getPayload(data) {
    const {
      channel,
      text,
      attachments,
      bot_id,
      user,
      user_profile,
      file,
    } = data;

    let payload = {
      roomId: channel,
      senderId: undefined
    };

    if (user) {
      const isMe = user === this.client.getSelfUserId();
      payload.senderId = isMe ? undefined : user;
      return this.client.getUserById(user)
        .then((uu) => {
            payload.senderName = uu.name;
            payload.avatarUrl = uu.profile.image_512;
            return payload;
        }).catch((err) => {
            console.log(err);
            payload.senderName = 'unknown';
            return payload;
        });
    } else if (bot_id) {
      return this.client.getBotById(bot_id)
        .then((bot) => {
            payload.senderName = bot.name;
            payload.senderId = bot_id;
            payload.avatarUrl = bot.icons.image_72
            return payload;
        }).catch((err) => {
            console.log(err);
            payload.senderName = 'unknown';
            return payload;
        });
    } else {
        console.log(payload);
        return new Promise((resolve, reject)=>{
            resolve(payload);
        });
    }
  }
  sendFile(data) {
    return this.getPayload(data).then((payload) => {
      payload.text = data.file.name;
      payload.url = ''; // to prevent errors
      payload.path = ''; // to prevent errors
      payload.file = data.file;
      return this.client.downloadImage(data.file.url_private).then(({ buffer, type }) => {
        payload.buffer = buffer;
        payload.mimetype = type;
        return this.handleThirdPartyRoomFileMessage(payload);
      }).catch((err) => {
        console.log(err);
        payload.text = '[Image] ('+data.name+') '+data.url;
        return this.handleThirdPartyRoomMessage(payload);
      });
    });
  }

  handleThirdPartyRoomFileMessage(thirdPartyRoomFileMessageData) {
    debug('handling third party room file message', thirdPartyRoomFileMessageData);
    let {
      roomId,
      senderName,
      senderId,
      avatarUrl,
      text,
      url, path, buffer, // either one is fine
      h,
      w,
      mimetype,
      file
    } = thirdPartyRoomFileMessageData;

    if (mimetype && mimetype.split('/')[0] === 'image') {
      return this.handleThirdPartyRoomImageMessage(thirdPartyRoomFileMessageData);
    }

    return this.getOrCreateMatrixRoomFromThirdPartyRoomId(roomId).then((matrixRoomId) => {
      return this.getUserClient(matrixRoomId, senderId, senderName, avatarUrl).then((client) => {
        if (senderId === undefined) {
          debug("this message was sent by me, but did it come from a matrix client or a 3rd party client?");
          debug("if it came from a 3rd party client, we want to repeat it as a 'notice' type message");
          debug("if it came from a matrix client, then it's already in the client, sending again would dupe");
          debug("we use a tag on the end of messages to determine if it came from matrix");

          if (typeof text === 'undefined') {
            debug("we can't know if this message is from matrix or not, so just ignore it");
            return;
          }
          else if (this.isTaggedMatrixMessage(text) || (path && isFilenameTagged(path))) {
            debug('it is from matrix, so just ignore it.');
            return;
          } else {
            debug('it is from 3rd party client');
          }
        }

        let upload = (buffer, opts) => {
          return client.uploadContent(buffer, Object.assign({
            name: text,
            type: mimetype,
            rawResponse: false
          }, opts || {})).then((res)=>{
            return {
              content_uri: res.content_uri || res,
              size: buffer.length
            };
          });
        };

        let promise;
        if ( url ) {
          promise = ()=> {
            return download.getBufferAndType(url).then(({buffer,type}) => {
              return upload(buffer, { type: mimetype || type });
            });
          };
        } else if ( path ) {
          promise = () => {
            return Promise.promisify(fs.readFile)(path).then(buffer => {
              return upload(buffer);
            });
          };
        } else if ( buffer ) {
          promise = () => upload(buffer);
        } else {
          promise = Promise.reject(new Error('missing url or path'));
        }

        promise().then(({ content_uri, size }) => {
          debug('uploaded to', content_uri);
          let file_opts = {
            body: (senderId === undefined) ? this.tagMatrixMessage(file.title) : file.title,
            filename: file.name,
            info: {
              mimetype: mimetype,
              size: size,
            },
            msgtype: "m.file",
            url: content_uri
          };
          if (file.mode === 'post' || file.mode === 'snippet') {
            let html = converter.makeHtml(
              '```' + file.filetype + '\n' + file.preview + '\n```' + ((file.lines_more > 0) ? '*truncated*' : '')
            );
            debug('about to send message', html, file.preview);

            let opts = {
              body: (senderId === undefined) ? this.tagMatrixMessage(file.preview) : file.preview,
              format: "org.matrix.custom.html",
              formatted_body: html,
              msgtype: "m.text"
            }
            return client.sendMessage(matrixRoomId, opts).then(()=>{
              return client.sendMessage(matrixRoomId, file_opts);
            }).catch((err)=>{
              debug('failed to post message', err);
            });
          }
          return client.sendMessage(matrixRoomId, file_opts);
        }, (err) =>{
          warn('upload error', err);

          let opts = {
            body: (senderId === undefined) ? this.tagMatrixMessage(texturl || path || text) : texturl || path || text,
            msgtype: "m.text"
          };
          return client.sendMessage(matrixRoomId, opts);
        });
      });
    });
  }

  createAndSendPayload(data) {
    const {
      channel,
      text,
      attachments,
      bot_id,
      user,
      user_profile,
      file,
    } = data;
    // any direct text
    let messages = [text];
    // any attachments, stuff it into the text as new lines
    if (attachments) {
      /* FIXME: Right now, doing this properly would cause too much churn.
       * The attachments are also in Slack's markdown-like
       * formatting, not real markdown, but they require features
       * (e.g. links with custom text) that Slack formatting doesn't support.
       * Because we need to process the "slackdown", but also implement those
       * features, we mix in some real markdown that makes it past our
       * slackdown-to-markdown converter. We also need <font> tags for our
       * colorization, but the converter can't handle the raw HTML (which
       * slackdown doesn't allow), and we don't want to turn HTML in Slack
       * messages into real HTML (it should show as plaintext just like it
       * does in Slack, lest we try to turn "</sarcasm>" into real end tags),
       * so we hack around it by implementing our own silly font color hack.
       * A good fix would be to parse individual messages' slackdown
       * to markdown, and add the additional markdown
       * (including raw HTML tags) afterward, instead of forming a big array
       * of slackdown messages, then converting them all into markdown at once.
       */
      attachments.forEach(att=> {
        let attMessages = [];
        if (att.pretext) {
          messages.push(att.pretext);
        }
        if (att.author_name) {
          if (att.author_link) {
            attMessages.push(`[${att.author_name}](${att.author_link})`);
          } else {
            attMessages.push(`${att.author_name}`);
          }
        }
        if (att.title) {
          if (att.title_link) {
            attMessages.push(`*[${att.title}](${att.title_link})*`);
          } else {
            attMessages.push(`*${att.title}*`);
          }
        }
        if (att.text) {
          attMessages.push(`${att.text}`);
        }
        if (att.fields) {
          att.fields.forEach(field => {
            if (field.title) {
              attMessages.push(`*${field.title}*`);
            }
            if (field.value) {
              attMessages.push(`${field.value}`);
            }
          })
        }
        if ((att.actions instanceof Array) && att.actions.length > 0) {
          attMessages.push(`Actions (Unsupported): ${att.actions.map(o => `[${o.text}]`).join(" ")}`);
        }
        if (att.footer) {
          attMessages.push(`_${att.footer}_`);
        }
        let attachmentBullet = att.color ? `;BEGIN_FONT_COLOR_HACK_${att.color};●;END_FONT_COLOR_HACK;` : "●";
        attMessages.forEach(attMessage => {
          messages.push(`${attachmentBullet} ${attMessage}`);
        });
      });
    }

    let rawMessage =
      messages
        .map(m => (typeof m === "string") ? m.trim() : m)
        .filter(m => m && (typeof m === "string"))
        .join('\n')
        .trim();

    return this.getPayload(data).then((payload) => {
      try {
        const replacements = [
          [':+1:', ':thumbsup:'],
          [':-1:', ':thumbsdown:'],
          [':facepunch:', ':punch:'],
          [':hankey:', ':poop:'],
          [':slightly_smiling_face:', ':slight_smile:'],
          [':upside_down_face:', ':upside_down:'],
          [':skin-tone-2:', '🏻'],
          [':skin-tone-3:', '🏼'],
          [':skin-tone-4:', '🏽'],
          [':skin-tone-5:', '🏾'],
          [':skin-tone-6:', '🏿'],
          ['<!channel>', '@room'],
          ['<!here>', '@room'],
            // NOTE: <!channel> and `<!here> converted to @room here,
            // and not in slacktomd, because we're translating Slack parlance
            // to Matrix parlance, not parsing "Slackdown" to turn into Markdown.
        ];
        for (let i = 0; i < replacements.length; i++) {
          rawMessage = rawMessage.replace(replacements[i][0], replacements[i][1]);
        }
        rawMessage = emojione.shortnameToUnicode(rawMessage);
        console.log("rawMessage");
        console.log(rawMessage);
        payload.text = slackdown(rawMessage, this);
        let markdown = payload.text;
        markdown = markdown.replace(/;BEGIN_FONT_COLOR_HACK_(.*?);/g, '<font color="$1">');
        markdown = markdown.replace(/;END_FONT_COLOR_HACK;/g, '</font>');
        payload.text = payload.text.replace(/;BEGIN_FONT_COLOR_HACK_(.*?);/g, '');
        payload.text = payload.text.replace(/;END_FONT_COLOR_HACK;/g, '');

        // Replace a slack user mention.
        // In the body it should be replaced with the nick and in the html a href.

        let result = [];
        while ((result = /USER_MENTION_HACK(.*?)END_USER_MENTION_HACK/g.exec(payload.text)) !== null) {
          console.log(result);
          const u = result[1];
          const isme = u === this.client.getSelfUserId();
          const user = this.client.getUserById(u);
          if (user) {
              const id = isme ? config.puppet.id : this.getGhostUserFromThirdPartySenderId(u);
              // todo: update user profile
              const name = isme ? config.puppet.localpart : user.name;
              const mentionmd = `[${name}](https://matrix.to/#/${id})`;
              payload.text = payload.text.replace(result[0], name);
              markdown = markdown.replace(result[0], mentionmd);
          } else {
              payload.text = payload.text.replace(result[0], u);
              markdown = markdown.replace(result[0], u);

          }
        }
        console.log("payload.text");
        console.log(payload.text);
        payload.html = converter.makeHtml(markdown);
        console.log("payload.html");
        console.log(payload.html);
      } catch (e) {
        console.log(e);
        debug("could not normalize message", e);
        payload.text = rawMessage;
      }

      return this.sendTyping({channel: data.channel, user: data.user}, false).then(() => {
          this.handleThirdPartyRoomMessage(payload).catch(err=>{
              console.error(err);
              this.sendStatusMsg({
                  fixedWidthOutput: true,
                  roomAliasLocalPart: `${this.slackPrefix}_${this.getStatusRoomPostfix()}`
              }, err.stack).catch((err)=>{
                  console.error(err);
              });
          });
      });
    });
  }

  getThirdPartyRoomDataById(id) {
    const directTopic = () => `Slack Direct Message (Team: ${this.teamName})`
    return this.client.getRoomById(id).then((room) => {
        if (room.is_im) {
            return this.client.getUserById(room.user).then((user) => {
                return {
                    name: user.name,
                    topic: directTopic()
                };
            });
        } else {
            return {
                name: room.name,
                topic: (typeof room.purpose === 'undefined') ? '' : room.purpose.value
            };
        }
    });
  }
  sendReadReceiptAsPuppetToThirdPartyRoomWithId() {
    // not available for now
  }
  sendMessageAsPuppetToThirdPartyRoomWithId(id, text, data) {
    debug('sending message as puppet to third party room with id', id);
    // text lost html informations, just use raw message instead that.
    let message;
    if (data.content.format === 'org.matrix.custom.html') {
      const rawMessage = data.content.formatted_body;
      message = mxtoslack(this, rawMessage);
    } else {
      message = data.content.body;
    }

    const replacements = [
      ['@room', this.notifyToSlack !== 'only_active' ? '<!channel>' : '<!here>'],
    ]
    for (let i = 0; i < replacements.length; i++) {
      message = message.replace(replacements[i][0], replacements[i][1]);
    }
    // deduplicate
    message = this.tagMatrixMessage(message);

    return this.client.sendMessage(message, id);
  }
  sendImageMessageAsPuppetToThirdPartyRoomWithId(id, data, raw) {
    return this.client.sendImageMessage(data.url, data.text, id);
  }
  sendFileMessageAsPuppetToThirdPartyRoomWithId(id, data) {
    // deduplicate
    const filename = this.tagMatrixMessage(data.filename);
    return this.client.sendFileMessage(data.url, data.text, filename, id);
  }
  initiateIm(data) {
    const { room_id, state_key } = data;
    const botIntent = this.getIntentFromApplicationServerBot();
    const botClient = botIntent.getClient();
    const puppet = this.puppet.getClient();
    const puppetUserId = puppet.credentials.userId;
    const botUserId = botClient.credentials.userId;
    const directTopic = () => `Slack Direct Message (Team: ${this.teamName})`
    const inviteBot = (room_id) => {
      return puppet.invite(room_id, botUserId).then(() => {
        return botIntent.join(room_id).then(() => {
          }).catch((err) => {
              debug('bot failed to join room', err);
          });
        })
      };

    var user = this.getThirdPartyUserIdFromMatrixGhostId(state_key);
    return this.client.openIm(user).then((res) => {
      let room = res.channel.id;
      let roomAlias = this.getRoomAliasFromThirdPartyRoomId(room);
      let roomAliasName = this.getRoomAliasLocalPartFromThirdPartyRoomId(room);
      return inviteBot(room_id).then(() => {
        return this.client.getUserById(user).then((slackuser) => {
          return puppet.createAlias(roomAlias, room_id).then(() => {
            puppet.setRoomName(room_id, slackuser.name).then(() => {
              puppet.setRoomTopic(room_id, directTopic()).then(() => {
                const ghostIntent = this.bridge.getIntent(this.getGhostUserFromThirdPartySenderId(user));
                ghostIntent.join(room_id).catch((err) => {
                  debug('failed to join user', err);
                });
              }).catch((err) => {
                debug('failed to set topic', err);
              });
            }).catch((err) => { debug('failed to set room name', err); });
            return roomAlias;
          }).catch((err) => { debug('failed to add room alias', err); });
        }).catch((err) => { debug('failed to get user', err); });
      }).catch((err) => { debug('failed to create room', err); });
    });
  }
}

module.exports = App;
