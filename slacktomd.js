"use strict";
const config = require('./config.json');

var he = require('he');

class slacktomd {
  constructor() {
  }

  _payloads(tag, start) {
    if(!start) {
      start = 0;
    }
    let length = tag.length;
    return this._pipeSplit(tag.substr(start, length - start));
  }

  _pipeSplit(payload) {
    return payload.split('|');
  }

  _tag(tag, attributes, payload) {
    if(!payload) {
      payload = attributes;
      attributes = {};
    }

    let html = "<".concat(tag);
    for (let attribute in attributes) {
      if (attributes.hasOwnProperty(attribute)) {
          html = html.concat(' ', attribute, '="', attributes[attribute], '"');
      }
    }
    return html.concat('>', payload, '</', tag, '>');
  }

  _getUser(u) {
    // Here we want to prevent slackdown from processing the mention,
    // but we delay the processing of the user id until app.js so that we can
    // seperate the handling of the plain text and formatted bodies.
    return `USER_MENTION_HACK${u}END_USER_MENTION_HACK`;
    var retVal = null;
    this.users.filter(username => {
      if (username.id === 'U' + u) {
        if (username.id != this.app.client.getSelfUserId()) {
          var matrixuser = this.app.getGhostUserFromThirdPartySenderId(username.id);
          retVal = '[' + username.name + '](https://matrix.to/#/' + matrixuser + ')';
        } else {
          var client = this.app.puppet.getClient();
          retVal = '[' + client.getUserIdLocalpart() + '](https://matrix.to/#/' + client.getUserId() + ')';
        }
      }
    })[0];
    if (retVal) {
      return retVal;
    }
    return u;
  }

  _getChannel(c) {
    return this.app.client.getChannelById(c).then((chan) => {
      if (chan) {
        const id = this.app.getRoomAliasFromThirdPartyRoomId(c);
        // update room profile
        return `[${chan.name}](https://matrix.to/#/${id})`;
      });
  }

  _matchTag(match, block = 0) {
    var action = match[1].substr(0,1), p;

    switch(action) {
      case "!":
        p = this._payloads(match[1], 1);
        let b = p.length == 1 ? p[0] : p[1];
        if (b === 'here') {
            return '@room';
        }
        return this._payloads(match[1]);
      case "#":
        p = this._payloads(match[1], 1);
        let c = p.length == 1 ? p[0] : p[1];
        return this._getChannel(c);
      case "@":
        p = this._payloads(match[1], 1);
        let u = p.length == 1 ? p[0] : p[1];
        return this._getUser(u);
      default:
        var expression = /^([a-z0-9+.-]+):(?:\/\/(?:((?:[a-z0-9-._~!$&'()*+,;=:]|%[0-9A-F]{2})*)@)?((?:[a-z0-9-._~!$&'()*+,;=]|%[0-9A-F]{2})*)(?::(\d*))?(\/(?:[a-z0-9-._~!$&'()*+,;=:@\/]|%[0-9A-F]{2})*)?|(\/?(?:[a-z0-9-._~!$&'()*+,;=:@]|%[0-9A-F]{2})+(?:[a-z0-9-._~!$&'()*+,;=:@\/]|%[0-9A-F]{2})*)?)(?:\?((?:[a-z0-9-._~!$&'()*+,;=:\/?@]|%[0-9A-F]{2})*))?(?:#((?:[a-z0-9-._~!$&'()*+,;=:\/?@]|%[0-9A-F]{2})*))?$/i;
        var regex = new RegExp(expression);
        p = this._payloads(match[1]);
        if (block > 0) {
          if (p.length > 1) {
            if (p[0] == p[1] || p[0] == 'http://' + p[1]) {
              return p[1];
            }
          }
          if (p[0].match(regex)) {
            return p[0];
          }
          return match[0];
        }
        return this._markdownTag("href", p[0], (p.length == 1 ? p[0] : p[1]));
    }
  }

  _markdownTag(tag, payload, linkText) {
    payload = payload.toString();

    if(!linkText) {
      linkText = payload;
    }

    switch(tag) {
      case "italic":
        return "_" + payload + "_";
        break;
      case "bold":
        return "**" + payload + "**";
        break;
      case "fixed":
        return "`" + payload + "`";
        break;
      case "blockFixed":
        return "```\n" + payload.trim() + "\n```";
        break;
      case "strike":
        return "~~" + payload + "~~";
        break;
      case "href":
        return "[" + linkText + "](" + payload + ")";
        break;
      default:
        return payload;
        break;
    }
  }

  _matchBold(match) {
    return this._safeMatch(match, this._markdownTag("bold", this._payloads(match[1])));
  }

  _matchItalic(match) {
    return this._safeMatch(match, this._markdownTag("italic", this._payloads(match[1])));
  }

  _matchFixed(match) {
    return this._safeMatch(match, this._markdownTag("fixed", he.decode(match[1])));
  }

  _matchBlockFixed(match) {
    return this._safeMatch(match, this._markdownTag("blockFixed", he.decode(match[1])));
  }

  _matchStrikeThrough(match) {
    return this._safeMatch(match, this._markdownTag("strike", this._payloads(match[1])));
  }

  _isWhiteSpace(input) {
    return /^\s?$/.test(input);
  }

  _safeMatch(match, tag) {
    var prefix_ok = match.index == 0;
    var postfix_ok = match.index == match.input.length - match[0].length;

    if(!prefix_ok) {
      let charAtLeft = match.input.substr(match.index - 1, 1);
      prefix_ok = this._isWhiteSpace(charAtLeft);
    }

    if(!postfix_ok) {
      let charAtRight = match.input.substr(match.index + match[0].length, 1);
      postfix_ok = this._isWhiteSpace(charAtRight);
    }

    if(prefix_ok && postfix_ok) {
      return tag;
    }
    return false;
  }

  _publicParse(text) {
    if (typeof text !== 'string') {
      return text;
    }
    var patterns = [
      {p: new RegExp('```([^`]+)```', 'g'), cb: "blockFixed"},
      {p: new RegExp('`([^`]+)`', 'g'), cb: "fixed"},
      {p: new RegExp('<([^>]+)>', 'g'), cb: "tag"},
      {p: new RegExp('\\*([^\\*]+)\\*', 'g'), cb: "bold"},
      {p: new RegExp('_([^_]+)_', 'g'), cb: "italic"},
      {p: new RegExp('~([^~]+)~', 'g'), cb: "strikeThrough"}
    ];

    let blocks = [];
    for (let p = 0; p < patterns.length; p++) {
      let pattern = patterns[p],
          original = text,
          result, replace;

      while ((result = pattern.p.exec(original)) !== null) {
        let lastIndex = pattern.p.lastIndex;
        let b;
        switch(pattern.cb) {
          case "tag":
            if ((b = blocks.findIndex(e => e.start < result.index)) > -1
              && lastIndex < blocks[b].end) {
              replace = this._matchTag(result, 1);
            } else {
              replace = this._matchTag(result);
            }
            break;
          case "bold":
            replace = this._matchBold(result);
            break;
          case "italic":
            replace = this._matchItalic(result);
            break;
          case "fixed":
            blocks.push({start: result.index, end: lastIndex});
            replace = this._matchFixed(result);
            break;
          case "blockFixed":
            blocks.push({start: result.index, end: lastIndex});
            replace = this._matchBlockFixed(result);
            break;
          case "strikeThrough":
            replace = this._matchStrikeThrough(result);
            break;
          default:
            return text;
            break;
        }

        if (replace) {
          text = text.replace(result[0], replace);
        }
      }
    }
    return text;
  }

  parse(app, text) {
    this.users = app.client.getUsers();
    this.channels = app.client.getChannels();
    this.app = app;
    return this._publicParse(text);
  }
}

module.exports = slacktomd;
