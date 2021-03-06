/*******************************************************************************

    uBlock Origin - a browser extension to block requests.
    Copyright (C) 2014-present Raymond Hill

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see {http://www.gnu.org/licenses/}.

    Home: https://github.com/gorhill/uBlock
*/

/* jshint bitwise: false */
/* global punycode, HNTrieContainer, STrieContainer */

'use strict';

/******************************************************************************/

µBlock.staticNetFilteringEngine = (function(){

/******************************************************************************/

const µb = µBlock;

// fedcba9876543210
//       |    | |||
//       |    | |||
//       |    | |||
//       |    | |||
//       |    | ||+---- bit    0: [BlockAction | AllowAction]
//       |    | |+----- bit    1: `important`
//       |    | +------ bit 2- 3: party [0 - 3]
//       |    +-------- bit 4- 8: type [0 - 31]
//       +------------- bit 9-15: unused

const BlockAction = 0 << 0;
const AllowAction = 1 << 0;
const Important   = 1 << 1;
const AnyParty    = 0 << 2;
const FirstParty  = 1 << 2;
const ThirdParty  = 2 << 2;

const AnyType = 0 << 4;
const typeNameToTypeValue = {
           'no_type':  0 << 4,
        'stylesheet':  1 << 4,
             'image':  2 << 4,
            'object':  3 << 4,
 'object_subrequest':  3 << 4,
            'script':  4 << 4,
             'fetch':  5 << 4,
    'xmlhttprequest':  5 << 4,
         'sub_frame':  6 << 4,
              'font':  7 << 4,
             'media':  8 << 4,
         'websocket':  9 << 4,
             'other': 10 << 4,
             'popup': 11 << 4,  // start of behavorial filtering
          'popunder': 12 << 4,
        'main_frame': 13 << 4,  // start of 1st-party-only behavorial filtering
       'generichide': 14 << 4,
       'inline-font': 15 << 4,
     'inline-script': 16 << 4,
              'data': 17 << 4,  // special: a generic data holder
          'redirect': 18 << 4,
            'webrtc': 19 << 4,
       'unsupported': 20 << 4
};
const otherTypeBitValue = typeNameToTypeValue.other;

const typeValueToTypeName = {
     1: 'stylesheet',
     2: 'image',
     3: 'object',
     4: 'script',
     5: 'xmlhttprequest',
     6: 'subdocument',
     7: 'font',
     8: 'media',
     9: 'websocket',
    10: 'other',
    11: 'popup',
    12: 'popunder',
    13: 'document',
    14: 'generichide',
    15: 'inline-font',
    16: 'inline-script',
    17: 'data',
    18: 'redirect',
    19: 'webrtc',
    20: 'unsupported'
};

const BlockAnyTypeAnyParty = BlockAction | AnyType | AnyParty;
const BlockAnyType = BlockAction | AnyType;
const BlockAnyParty = BlockAction | AnyParty;

const AllowAnyTypeAnyParty = AllowAction | AnyType | AnyParty;
const AllowAnyType = AllowAction | AnyType;
const AllowAnyParty = AllowAction | AnyParty;

const genericHideException = AllowAction | AnyParty | typeNameToTypeValue.generichide,
      genericHideImportant = BlockAction | AnyParty | typeNameToTypeValue.generichide | Important;

// ABP filters: https://adblockplus.org/en/filters
// regex tester: http://regex101.com/

/******************************************************************************/

// See the following as short-lived registers, used during evaluation. They are
// valid until the next evaluation.

let pageHostnameRegister = '',
    requestHostnameRegister = '';
//var filterRegister = null;
//var categoryRegister = '';

// Local helpers

const normalizeRegexSource = function(s) {
    try {
        const re = new RegExp(s);
        return re.source;
    } catch (ex) {
        normalizeRegexSource.message = ex.toString();
    }
    return '';
};

const rawToRegexStr = function(s, anchor) {
    // https://www.loggly.com/blog/five-invaluable-techniques-to-improve-regex-performance/
    // https://developer.mozilla.org/en/docs/Web/JavaScript/Guide/Regular_Expressions
    // Also: remove leading/trailing wildcards -- there is no point.
    let reStr = s.replace(rawToRegexStr.escape1, '\\$&')
                 .replace(rawToRegexStr.escape2, '(?:[^%.0-9a-z_-]|$)')
                 .replace(rawToRegexStr.escape3, '')
                 .replace(rawToRegexStr.escape4, '[^ ]*?');
    if ( anchor & 0b100 ) {
        reStr = (
            reStr.startsWith('\\.') ?
                rawToRegexStr.reTextHostnameAnchor2 :
                rawToRegexStr.reTextHostnameAnchor1
        ) + reStr;
    } else if ( anchor & 0b010 ) {
        reStr = '^' + reStr;
    }
    if ( anchor & 0b001 ) {
        reStr += '$';
    }
    return reStr;
};
rawToRegexStr.escape1 = /[.+?${}()|[\]\\]/g;
rawToRegexStr.escape2 = /\^/g;
rawToRegexStr.escape3 = /^\*|\*$/g;
rawToRegexStr.escape4 = /\*/g;
rawToRegexStr.reTextHostnameAnchor1 = '^[a-z-]+://(?:[^/?#]+\\.)?';
rawToRegexStr.reTextHostnameAnchor2 = '^[a-z-]+://(?:[^/?#]+)?';

// https://github.com/uBlockOrigin/uAssets/issues/4083#issuecomment-436914727
const rawToPlainStr = function(s, anchor) {
    if (
        anchor === 0 &&
        s.charCodeAt(0) === 0x2F /* '/' */ &&
        s.length > 2 &&
        s.charCodeAt(s.length-1) === 0x2F /* '/' */
    ) {
        s = s + '*';
    }
    return s;
};

const filterDataSerialize = µb.CompiledLineIO.serialize;

const toLogDataInternal = function(categoryBits, tokenHash, filter) {
    if ( filter === null ) { return undefined; }
    const logData = filter.logData();
    logData.compiled = filterDataSerialize([
        categoryBits,
        tokenHash,
        logData.compiled
    ]);
    if ( categoryBits & 0x001 ) {
        logData.raw = `@@${logData.raw}`;
    }
    const opts = [];
    if ( categoryBits & 0x002 ) {
        opts.push('important');
    }
    if ( categoryBits & 0x008 ) {
        opts.push('third-party');
    } else if ( categoryBits & 0x004 ) {
        opts.push('first-party');
    }
    const type = categoryBits & 0x1F0;
    if ( type !== 0 && type !== typeNameToTypeValue.data ) {
        opts.push(typeValueToTypeName[type >>> 4]);
    }
    if ( logData.opts !== undefined ) {
        opts.push(logData.opts);
    }
    if ( opts.length !== 0 ) {
        logData.raw += '$' + opts.join(',');
    }
    return logData;
};

// First character of match must be within the hostname part of the url.
//
// https://github.com/gorhill/uBlock/issues/1929
//   Match only hostname label boundaries.
const isHnAnchored = (function() {
    let hostname = '';
    let beg = -1, end = -1;

    return function(url, matchStart) {
        if ( requestHostnameRegister !== hostname ) {
            const hn = requestHostnameRegister;
            beg = hn !== '' ? url.indexOf(hn) : -1;
            end = beg !== -1 ? beg + hn.length : -1;
            hostname = hn;
        }
        if ( matchStart < beg || matchStart >= end ) { return false; }
        return matchStart === beg ||
               url.charCodeAt(matchStart - 1) === 0x2E /* '.' */;
    };
})();


/*******************************************************************************

    Each filter class will register itself in the map. A filter class
    id MUST always stringify to ONE single character.

    IMPORTANT: any change which modifies the mapping will have to be
    reflected with µBlock.systemSettings.compiledMagic.

    As of 2019-04-13:

        Filter classes histogram with default filter lists:

        {"FilterPlainHnAnchored" => 12619}
        {"FilterPlainPrefix1" => 8743}
        {"FilterGenericHnAnchored" => 5231}
        {"FilterOriginHit" => 4149}
        {"FilterPair" => 2381}
        {"FilterBucket" => 1940}
        {"FilterPlainHostname" => 1612}
        {"FilterOriginHitSet" => 1430}
        {"FilterPlainLeftAnchored" => 799}
        {"FilterGeneric" => 588}
        {"FilterPlain" => 510}
        {"FilterOriginMiss" => 299}
        {"FilterDataHolder" => 280}
        {"FilterOriginMissSet" => 150}
        {"FilterTrue" => 130}
        {"FilterRegex" => 124}
        {"FilterPlainRightAnchored" => 110}
        {"FilterGenericHnAndRightAnchored" => 95}
        {"FilterHostnameDict" => 59}
        {"FilterPlainPrefix0" => 29}
        {"FilterExactMatch" => 5}
        {"FilterOriginMixedSet" => 3}

        Observations:
        - No need for FilterPlainPrefix0.
        - FilterPlainHnAnchored and FilterPlainPrefix1 are good candidates
          for storing in a plain string trie.

**/

const filterClasses = [];
let   filterClassIdGenerator = 0;
const filterClassHistogram = new Map();

const registerFilterClass = function(ctor) {
    let fid = filterClassIdGenerator++;
    ctor.fid = ctor.prototype.fid = fid;
    filterClasses[fid] = ctor;
};

const filterFromCompiledData = function(args) {
    //const ctor = filterClasses[args[0]].name;
    //filterClassHistogram.set(ctor, (filterClassHistogram.get(ctor) || 0) + 1);
    return filterClasses[args[0]].load(args);
};

/******************************************************************************/

const FilterTrue = class {
    match() {
        return true;
    }

    logData() {
        return {
            raw: '*',
            regex: '^',
            compiled: this.compile(),
        };
    }

    compile() {
        return [ this.fid ];
    }

    static compile() {
        return [ FilterTrue.fid ];
    }

    static load() {
        return FilterTrue.instance;
    }
};

FilterTrue.instance = new FilterTrue();

registerFilterClass(FilterTrue);

/******************************************************************************/

const FilterPlain = class {
    constructor(s, tokenBeg) {
        this.s = s;
        this.tokenBeg = tokenBeg;
    }

    match(url, tokenBeg) {
        return url.startsWith(this.s, tokenBeg - this.tokenBeg);
    }

    logData() {
        return {
            raw: rawToPlainStr(this.s, 0),
            regex: rawToRegexStr(this.s, 0),
            compiled: this.compile()
        };
    }

    compile() {
        return [ this.fid, this.s, this.tokenBeg ];
    }

    static compile(details) {
        return [ FilterPlain.fid, details.f, details.tokenBeg ];
    }

    static load(args) {
        return new FilterPlain(args[1], args[2]);
    }
};

registerFilterClass(FilterPlain);

/******************************************************************************/

const FilterPlainPrefix1 = class {
    constructor(s) {
        this.s = s;
    }

    match(url, tokenBeg) {
        return url.startsWith(this.s, tokenBeg - 1);
    }

    logData() {
        return {
            raw: rawToPlainStr(this.s, 0),
            regex: rawToRegexStr(this.s, 0),
            compiled: this.compile()
        };
    }

    compile() {
        return [ this.fid, this.s ];
    }

    static compile(details) {
        return [ FilterPlainPrefix1.fid, details.f ];
    }

    static load(args) {
        return new FilterPlainPrefix1(args[1]);
    }

    static trieableStringFromArgs(args) {
        return args[1];
    }
};

FilterPlainPrefix1.prototype.trieableId = 0;

registerFilterClass(FilterPlainPrefix1);

/******************************************************************************/

const FilterPlainHostname = class {
    constructor(s) {
        this.s = s;
    }

    match() {
        const haystack = requestHostnameRegister;
        const needle = this.s;
        if ( haystack.endsWith(needle) === false ) { return false; }
        const offset = haystack.length - needle.length;
        return offset === 0 || haystack.charCodeAt(offset - 1) === 0x2E /* '.' */;
    }

    logData() {
        return {
            raw: `||${this.s}^`,
            regex: rawToRegexStr(`${this.s}^`, 0),
            compiled: this.compile()
        };
    }

    compile() {
        return [ this.fid, this.s ];
    }

    static compile(details) {
        return [ FilterPlainHostname.fid, details.f ];
    }

    static load(args) {
        return new FilterPlainHostname(args[1]);
    }
};

registerFilterClass(FilterPlainHostname);

/******************************************************************************/

const FilterPlainLeftAnchored = class {
    constructor(s) {
        this.s = s;
    }

    match(url) {
        return url.startsWith(this.s);
    }

    logData() {
        return {
            raw: `|${this.s}`,
            regex: rawToRegexStr(this.s, 0b010),
            compiled: this.compile()
        };
    }

    compile() {
        return [ this.fid, this.s ];
    }

    static compile(details) {
        return [ FilterPlainLeftAnchored.fid, details.f ];
    }

    static load(args) {
        return new FilterPlainLeftAnchored(args[1]);
    }
};

registerFilterClass(FilterPlainLeftAnchored);

/******************************************************************************/

const FilterPlainRightAnchored = class {
    constructor(s) {
        this.s = s;
    }

    match(url) {
        return url.endsWith(this.s);
    }

    logData() {
        return {
            raw: `${this.s}|`,
            regex: rawToRegexStr(this.s, 0b001),
            compiled: this.compile()
        };
    }

    compile() {
        return [ this.fid, this.s ];
    }

    static compile(details) {
        return [ FilterPlainRightAnchored.fid, details.f ];
    }

    static load(args) {
        return new FilterPlainRightAnchored(args[1]);
    }
};

registerFilterClass(FilterPlainRightAnchored);

/******************************************************************************/

const FilterExactMatch = class {
    constructor(s) {
        this.s = s;
    }

    match(url) {
        return url === this.s;
    }

    logData() {
        return {
            raw: `|${this.s}|`,
            regex: rawToRegexStr(this.s, 0b011),
            compiled: this.compile()
        };
    }

    compile() {
        return [ this.fid, this.s ];
    }

    static compile(details) {
        return [ FilterExactMatch.fid, details.f ];
    }

    static load(args) {
        return new FilterExactMatch(args[1]);
    }
};

registerFilterClass(FilterExactMatch);

/******************************************************************************/

const FilterPlainHnAnchored = class {
    constructor(s) {
        this.s = s;
    }

    match(url, tokenBeg) {
        return url.startsWith(this.s, tokenBeg) &&
               isHnAnchored(url, tokenBeg);
    }

    logData() {
        return {
            raw: `||${this.s}`,
            regex: rawToRegexStr(this.s, 0),
            compiled: this.compile()
        };
    }

    compile() {
        return [ this.fid, this.s ];
    }

    static compile(details) {
        return [ FilterPlainHnAnchored.fid, details.f ];
    }

    static load(args) {
        return new FilterPlainHnAnchored(args[1]);
    }

    static trieableStringFromArgs(args) {
        return args[1];
    }
};

FilterPlainHnAnchored.prototype.trieableId = 1;

registerFilterClass(FilterPlainHnAnchored);

/******************************************************************************/

const FilterGeneric = class {
    constructor(s, anchor) {
        this.s = s;
        this.anchor = anchor;
    }

    match(url) {
        if ( this.re === null ) {
            this.re = new RegExp(rawToRegexStr(this.s, this.anchor));
        }
        return this.re.test(url);
    }

    logData() {
        const out = {
            raw: rawToPlainStr(this.s, this.anchor),
            regex: this.re.source,
            compiled: this.compile()
        };
        if ( this.anchor & 0x2 ) {
            out.raw = `|${out.raw}`;
        }
        if ( this.anchor & 0x1 ) {
            out.raw += '|';
        }
        return out;
    }

    compile() {
        return [ this.fid, this.s, this.anchor ];
    }

    static compile(details) {
        return [ FilterGeneric.fid, details.f, details.anchor ];
    }

    static load(args) {
        return new FilterGeneric(args[1], args[2]);
    }
};

FilterGeneric.prototype.re = null;

registerFilterClass(FilterGeneric);

/******************************************************************************/

const FilterGenericHnAnchored = class {
    constructor(s) {
        this.s = s;
    }

    match(url) {
        if ( this.re === null ) {
            this.re = new RegExp(rawToRegexStr(this.s, this.anchor));
        }
        return this.re.test(url);
    }

    logData() {
        return {
            raw: `||${this.s}`,
            regex: rawToRegexStr(this.s, this.anchor & 0b001),
            compiled: this.compile()
        };
    }

    compile() {
        return [ this.fid, this.s ];
    }

    static compile(details) {
        return [ FilterGenericHnAnchored.fid, details.f ];
    }

    static load(args) {
        return new FilterGenericHnAnchored(args[1]);
    }
};

FilterGenericHnAnchored.prototype.re = null;
FilterGenericHnAnchored.prototype.anchor = 0x4;

registerFilterClass(FilterGenericHnAnchored);

/******************************************************************************/

const FilterGenericHnAndRightAnchored = class extends FilterGenericHnAnchored {
    logData() {
        const out = super.logData();
        out.raw += '|';
        return out;
    }

    static compile(details) {
        return [ FilterGenericHnAndRightAnchored.fid, details.f ];
    }

    static load(args) {
        return new FilterGenericHnAndRightAnchored(args[1]);
    }
};

FilterGenericHnAndRightAnchored.prototype.anchor = 0x5;

registerFilterClass(FilterGenericHnAndRightAnchored);

/******************************************************************************/

const FilterRegex = class {
    constructor(s) {
        this.re = s;
    }

    match(url) {
        if ( typeof this.re === 'string' ) {
            this.re = new RegExp(this.re, 'i');
        }
        return this.re.test(url);
    }

    logData() {
        const s = typeof this.re === 'string' ? this.re : this.re.source;
        return {
            raw: `/${s}/`,
            regex: s,
            compiled: this.compile()
        };
    }

    compile() {
        return [
            this.fid,
            typeof this.re === 'string' ? this.re : this.re.source
        ];
    }

    static compile(details) {
        return [ FilterRegex.fid, details.f ];
    }

    static load(args) {
        return new FilterRegex(args[1]);
    }
};

registerFilterClass(FilterRegex);

/******************************************************************************/

// The optimal "class" is picked according to the content of the
// `domain=` filter option.

const filterOrigin = {
    compile: function(details, wrapped) {
        const domainOpt = details.domainOpt;
        // One hostname
        if ( domainOpt.indexOf('|') === -1 ) {
            if ( domainOpt.charCodeAt(0) === 0x7E /* '~' */ ) {
                return FilterOriginMiss.compile(domainOpt, wrapped);
            }
            return FilterOriginHit.compile(domainOpt, wrapped);
        }
        // Many hostnames.
        // Must be in set (none negated).
        if ( domainOpt.indexOf('~') === -1 ) {
            return FilterOriginHitSet.compile(domainOpt, wrapped);
        }
        // Must not be in set (all negated).
        const reAllNegated = /^~(?:[^|~]+\|~)+[^|~]+$/;
        if ( reAllNegated.test(domainOpt) ) {
            return FilterOriginMissSet.compile(domainOpt, wrapped);
        }
        // Must be in one set, but not in the other.
        return FilterOriginMixedSet.compile(domainOpt, wrapped);
    },
    logData: function(f, arg1, arg2) {
        const out = f.wrapped.logData();
        out.compiled = [ f.fid, arg1, out.compiled ];
        if ( out.opts !== undefined ) { out.opts += ','; }
        out.opts = `domain=${arg2 || arg1}`;
        return out;
    },
    trieContainer: (function() {
        let trieDetails;
        try {
            trieDetails = JSON.parse(
                vAPI.localStorage.getItem('FilterOrigin.trieDetails')
            );
        } catch(ex) {
        }
        return new HNTrieContainer(trieDetails);
    })(),
    readyToUse: function() {
        return this.trieContainer.readyToUse();
    },
    reset: function() {
        return this.trieContainer.reset();
    },
    optimize: function() {
        const trieDetails = this.trieContainer.optimize();
        vAPI.localStorage.setItem(
            'FilterOrigin.trieDetails',
            JSON.stringify(trieDetails)
        );
    },
};

/******************************************************************************/

// Surprinsingly, first peeking and comparing only the first character using
// charCodeAt() does help a bit performance -- 3-6µs gain per request on
// average for Chromium 71 and Firefox 65 with default lists.
// A likely explanation is that most visits are a miss, and in such case
// calling charCodeAt() to bail out earlier is cheaper than calling endsWith().

const FilterOriginHit = class {
    constructor(hostname, wrapped) {
        this.hostname = hostname;
        this.wrapped = wrapped;
    }

    match(url, tokenBeg) {
        const haystack = pageHostnameRegister;
        const offset = haystack.length - this.hostname.length;
        if ( offset < 0 ) { return false; }
        if ( haystack.charCodeAt(offset) !== this.hostname.charCodeAt(0) ) {
            return false;
        }
        if ( haystack.endsWith(this.hostname) === false ) { return false; }
        if ( offset !== 0 && haystack.charCodeAt(offset-1) !== 0x2E /* '.' */ ) {
            return false;
        }
        return this.wrapped.match(url, tokenBeg);
    }

    logData() {
        return filterOrigin.logData(this, this.hostname);
    }

    compile() {
        return [ this.fid, this.hostname, this.wrapped.compile() ];
    }

    static compile(domainOpt, wrapped) {
        return [ FilterOriginHit.fid, domainOpt, wrapped ];
    }

    static load(args) {
        return new FilterOriginHit(
            args[1],
            filterFromCompiledData(args[2])
        );
    }
};

registerFilterClass(FilterOriginHit);

/******************************************************************************/

const FilterOriginMiss = class {
    constructor(hostname, wrapped) {
        this.hostname = hostname;
        this.wrapped = wrapped;
    }

    match(url, tokenBeg) {
        const haystack = pageHostnameRegister;
        if ( haystack.endsWith(this.hostname) ) {
            const offset = haystack.length - this.hostname.length;
            if ( offset === 0 || haystack.charCodeAt(offset-1) === 0x2E /* '.' */ ) {
                return false;
            }
        }
        return this.wrapped.match(url, tokenBeg);
    }

    logData() {
        return filterOrigin.logData(this, this.hostname, `~${this.hostname}`);
    }

    compile() {
        return [ this.fid, this.hostname, this.wrapped.compile() ];
    }

    static compile(domainOpt, wrapped) {
        return [ FilterOriginMiss.fid, domainOpt.slice(1), wrapped ];
    }

    static load(args) {
        return new FilterOriginMiss(
            args[1],
            filterFromCompiledData(args[2])
        );
    }
};

registerFilterClass(FilterOriginMiss);

/******************************************************************************/

const FilterOriginHitSet = class {
    constructor(domainOpt, wrapped) {
        this.domainOpt = domainOpt.length < 128
            ? domainOpt
            : µb.stringDeduplicater.lookup(domainOpt);
        this.oneOf = null;
        this.wrapped = wrapped;
    }

    match(url, tokenBeg) {
        if ( this.oneOf === null ) {
            this.oneOf = filterOrigin.trieContainer.fromIterable(
                this.domainOpt.split('|')
            );
        }
        return this.oneOf.matches(pageHostnameRegister) !== -1 &&
               this.wrapped.match(url, tokenBeg);
    }

    logData() {
        return filterOrigin.logData(this, this.domainOpt);
    }

    compile() {
        return [ this.fid, this.domainOpt, this.wrapped.compile() ];
    }

    static compile(domainOpt, wrapped) {
        return [ FilterOriginHitSet.fid, domainOpt, wrapped ];
    }

    static load(args) {
        return new FilterOriginHitSet(
            args[1],
            filterFromCompiledData(args[2])
        );
    }
};

registerFilterClass(FilterOriginHitSet);

/******************************************************************************/

const FilterOriginMissSet = class {
    constructor(domainOpt, wrapped) {
        this.domainOpt = domainOpt.length < 128
            ? domainOpt
            : µb.stringDeduplicater.lookup(domainOpt);
        this.noneOf = null;
        this.wrapped = wrapped;
    }

    match(url, tokenBeg) {
        if ( this.noneOf === null ) {
            this.noneOf = filterOrigin.trieContainer.fromIterable(
                this.domainOpt.replace(/~/g, '').split('|')
            );
        }
        return this.noneOf.matches(pageHostnameRegister) === -1 &&
               this.wrapped.match(url, tokenBeg);
    }

    logData() {
        return filterOrigin.logData(this, this.domainOpt);
    }

    compile() {
        return [ this.fid, this.domainOpt, this.wrapped.compile() ];
    }

    static compile(domainOpt, wrapped) {
        return [ FilterOriginMissSet.fid, domainOpt, wrapped ];
    }

    static load(args) {
        return new FilterOriginMissSet(
            args[1],
            filterFromCompiledData(args[2])
        );
    }
};

registerFilterClass(FilterOriginMissSet);

/******************************************************************************/

const FilterOriginMixedSet = class {
    constructor(domainOpt, wrapped) {
        this.domainOpt = domainOpt.length < 128
            ? domainOpt
            : µb.stringDeduplicater.lookup(domainOpt);
        this.oneOf = null;
        this.noneOf = null;
        this.wrapped = wrapped;
    }

    init() {
        const oneOf = [], noneOf = [];
        for ( const hostname of this.domainOpt.split('|') ) {
            if ( hostname.charCodeAt(0) === 0x7E /* '~' */ ) {
                noneOf.push(hostname.slice(1));
            } else {
                oneOf.push(hostname);
            }
        }
        this.oneOf = filterOrigin.trieContainer.fromIterable(oneOf);
        this.noneOf = filterOrigin.trieContainer.fromIterable(noneOf);
    }

    match(url, tokenBeg) {
        if ( this.oneOf === null ) { this.init(); }
        let needle = pageHostnameRegister;
        return this.oneOf.matches(needle) !== -1 &&
               this.noneOf.matches(needle) === -1 &&
               this.wrapped.match(url, tokenBeg);
    }

    logData() {
        return filterOrigin.logData(this, this.domainOpt);
    }

    compile() {
        return [ this.fid, this.domainOpt, this.wrapped.compile() ];
    }

    static compile(domainOpt, wrapped) {
        return [ FilterOriginMixedSet.fid, domainOpt, wrapped ];
    }

    static load(args) {
        return new FilterOriginMixedSet(
            args[1],
            filterFromCompiledData(args[2])
        );
    }
};

registerFilterClass(FilterOriginMixedSet);

/******************************************************************************/

const FilterDataHolder = class {
    constructor(dataType, dataStr) {
        this.dataType = dataType;
        this.dataStr = dataStr;
        this.wrapped = undefined;
    }

    match(url, tokenBeg) {
        return this.wrapped.match(url, tokenBeg);
    }

    logData() {
        const out = this.wrapped.logData();
        out.compiled = [ this.fid, this.dataType, this.dataStr, out.compiled ];
        let opt = this.dataType;
        if ( this.dataStr !== '' ) {
            opt += `=${this.dataStr}`;
        }
        if ( out.opts === undefined ) {
            out.opts = opt;
        } else {
            out.opts = opt + ',' + out.opts;
        }
        return out;
    }

    compile() {
        return [ this.fid, this.dataType, this.dataStr, this.wrapped.compile() ];
    }

    static compile(details) {
        return [ FilterDataHolder.fid, details.dataType, details.dataStr ];
    }

    static load(args) {
        const f = new FilterDataHolder(args[1], args[2]);
        f.wrapped = filterFromCompiledData(args[3]);
        return f;
    }
};

registerFilterClass(FilterDataHolder);

// Helper class for storing instances of FilterDataHolder.

const FilterDataHolderEntry = class {
    constructor(categoryBits, tokenHash, fdata) {
        this.categoryBits = categoryBits;
        this.tokenHash = tokenHash;
        this.filter = filterFromCompiledData(fdata);
        this.next = undefined;
    }

    logData() {
        return toLogDataInternal(this.categoryBits, this.tokenHash, this.filter);
    }

    compile() {
        return [ this.categoryBits, this.tokenHash, this.filter.compile() ];
    }

    static load(data) {
        return new FilterDataHolderEntry(data[0], data[1], data[2]);
    }
};

/******************************************************************************/

// Dictionary of hostnames

const FilterHostnameDict = class {
    constructor(args) {
        this.h = ''; // short-lived register
        this.dict = FilterHostnameDict.trieContainer.createOne(args);
    }

    get size() {
        return this.dict.size;
    }

    add(hn) {
        return this.dict.add(hn);
    }

    match() {
        const pos = this.dict.matches(requestHostnameRegister);
        if ( pos === -1 ) { return false; }
        this.h = requestHostnameRegister.slice(pos);
        return true;
    }

    logData() {
        return {
            raw: `||${this.h}^`,
            regex: `${rawToRegexStr(this.h, 0)}(?:[^%.0-9a-z_-]|$)`,
            compiled: this.h
        };
    }

    compile() {
        return [ this.fid, FilterHostnameDict.trieContainer.compileOne(this.dict) ];
    }

    static readyToUse() {
        return FilterHostnameDict.trieContainer.readyToUse();
    }

    static reset() {
        return FilterHostnameDict.trieContainer.reset();
    }

    static optimize() {
        const trieDetails = FilterHostnameDict.trieContainer.optimize();
        vAPI.localStorage.setItem(
            'FilterHostnameDict.trieDetails',
            JSON.stringify(trieDetails)
        );
    }

    static load(args) {
        return new FilterHostnameDict(args[1]);
    }
};

FilterHostnameDict.trieContainer = (function() {
    let trieDetails;
    try {
        trieDetails = JSON.parse(
            vAPI.localStorage.getItem('FilterHostnameDict.trieDetails')
        );
    } catch(ex) {
    }
    return new HNTrieContainer(trieDetails);
})();

registerFilterClass(FilterHostnameDict);

/******************************************************************************/

// Some buckets can grow quite large, and finding a hit in these buckets
// may end up being expensive. After considering various solutions, the one
// retained is to promote hit filters to a smaller index, so that next time
// they can be looked-up faster.

// key=  10000 ad           count=660
// key=  10000 ads          count=433
// key=  10001 google       count=277
// key=1000000 2mdn         count=267
// key=  10000 social       count=240
// key=  10001 pagead2      count=166
// key=  10000 twitter      count=122
// key=  10000 doubleclick  count=118
// key=  10000 facebook     count=114
// key=  10000 share        count=113
// key=  10000 google       count=106
// key=  10001 code         count=103
// key=  11000 doubleclick  count=100
// key=1010001 g            count=100
// key=  10001 js           count= 89
// key=  10000 adv          count= 88
// key=  10000 youtube      count= 61
// key=  10000 plugins      count= 60
// key=  10001 partner      count= 59
// key=  10000 ico          count= 57
// key= 110001 ssl          count= 57
// key=  10000 banner       count= 53
// key=  10000 footer       count= 51
// key=  10000 rss          count= 51

/******************************************************************************/

const FilterPair = class {
    constructor(a, b) {
        this.f1 = a;
        this.f2 = b;
    }

    get size() {
        if ( this.f1 === undefined && this.f2 === undefined ) { return 0; }
        if ( this.f1 === undefined || this.f2 === undefined ) { return 1; }
        return 2;
    }

    match(url, tokenBeg) {
        if ( this.f1.match(url, tokenBeg) === true ) {
            this.f = this.f1;
            return true;
        }
        if ( this.f2.match(url, tokenBeg) === true ) {
            this.f = this.f2;
            return true;
        }
        return false;
    }

    logData() {
        return this.f.logData();
    }

    compile() {
        return [ this.fid, this.f1.compile(), this.f2.compile() ];
    }

    upgrade(a) {
        const bucket = new FilterBucket(this.f1, this.f2, a);
        this.f1 = this.f2 = undefined;
        this.f = null;
        FilterPair.available = this;
        return bucket;
    }

    static load(args) {
        const f1 = filterFromCompiledData(args[1]);
        const f2 = filterFromCompiledData(args[2]);
        const pair = FilterPair.available;
        if ( pair === null ) {
            return new FilterPair(f1, f2);
        }
        FilterPair.available = null;
        pair.f1 = f1;
        pair.f2 = f2;
        return pair;
    }
};

FilterPair.prototype.f = null;

FilterPair.available = null;

registerFilterClass(FilterPair);

/******************************************************************************/

const FilterBucket = class {
    constructor(a, b, c) {
        this.filters = [];
        if ( a !== undefined ) {
            this.filters.push(a, b, c);
            this._countTrieable();
        }
    }

    get size() {
        let size = this.filters.length;
        if ( this.plainPrefix1Trie !== null ) {
            size += this.plainPrefix1Trie.size;
        }
        if ( this.plainHnAnchoredTrie !== null ) {
            size += this.plainHnAnchoredTrie.size;
        }
        return size;
    }

    add(fdata) {
        if ( fdata[0] === this.plainPrefix1Id ) {
            if ( this.plainPrefix1Trie !== null ) {
                return this.plainPrefix1Trie.add(
                    FilterPlainPrefix1.trieableStringFromArgs(fdata)
                );
            }
            if ( this.plainPrefix1Count === 3 ) {
                this.plainPrefix1Trie = FilterBucket.trieContainer.createOne();
                this._transferTrieable(
                    this.plainPrefix1Id,
                    this.plainPrefix1Trie
                );
                return this.plainPrefix1Trie.add(
                    FilterPlainPrefix1.trieableStringFromArgs(fdata)
                );
            }
            this.plainPrefix1Count += 1;
        }
        if ( fdata[0] === this.plainHnAnchoredId ) {
            if ( this.plainHnAnchoredTrie !== null ) {
                return this.plainHnAnchoredTrie.add(
                    FilterPlainHnAnchored.trieableStringFromArgs(fdata)
                );
            }
            if ( this.plainHnAnchoredCount === 3 ) {
                this.plainHnAnchoredTrie = FilterBucket.trieContainer.createOne();
                this._transferTrieable(
                    this.plainHnAnchoredId,
                    this.plainHnAnchoredTrie
                );
                return this.plainHnAnchoredTrie.add(
                    FilterPlainHnAnchored.trieableStringFromArgs(fdata)
                );
            }
            this.plainHnAnchoredCount += 1;
        }
        this.filters.push(filterFromCompiledData(fdata));
    }

    match(url, tokenBeg) {
        if ( this.plainPrefix1Trie !== null ) {
            const pos = this.plainPrefix1Trie.matches(url, tokenBeg - 1);
            if ( pos !== -1 ) {
                this.plainPrefix1Filter.s = url.slice(tokenBeg - 1, pos);
                this.f = this.plainPrefix1Filter;
                return true;
            }
        }
        if ( this.plainHnAnchoredTrie !== null && isHnAnchored(url, tokenBeg) ) {
            const pos = this.plainHnAnchoredTrie.matches(url, tokenBeg);
            if ( pos !== -1 ) {
                this.plainHnAnchoredFilter.s = url.slice(tokenBeg, pos);
                this.f = this.plainHnAnchoredFilter;
                return true;
            }
        }
        const filters = this.filters;
        for ( let i = 0, n = filters.length; i < n; i++ ) {
            if ( filters[i].match(url, tokenBeg) === true ) {
                this.f = filters[i];
                if ( i >= 16 ) { this._promote(i); }
                return true;
            }
        }
        return false;
    }

    logData() {
        return this.f.logData();
    }

    compile() {
        const compiled = [];
        const filters = this.filters;
        for ( let i = 0, n = filters.length; i < n; i++ ) {
            compiled[i] = filters[i].compile();
        }
        return [
            this.fid,
            compiled,
            this.plainPrefix1Trie !== null &&
                FilterBucket.trieContainer.compileOne(this.plainPrefix1Trie),
            this.plainHnAnchoredTrie !== null &&
                FilterBucket.trieContainer.compileOne(this.plainHnAnchoredTrie),
        ];
    }

    _countTrieable() {
        for ( const f of this.filters ) {
            if ( f.fid === this.plainPrefix1Id ) {
                this.plainPrefix1Count += 1;
            } else if ( f.fid === this.plainHnAnchoredId ) {
                this.plainHnAnchoredCount += 1;
            }
        }
    }

    _transferTrieable(fid, trie) {
        let i = this.filters.length;
        while ( i-- ) {
            const f = this.filters[i];
            if ( f.fid !== fid || f.s.length > 255 ) { continue; }
            trie.add(f.s);
            this.filters.splice(i, 1);
        }
    }

    // Promote hit filters so they can be found faster next time.
    _promote(i) {
        const filters = this.filters;
        let pivot = filters.length >>> 1;
        while ( i < pivot ) {
            pivot >>>= 1;
            if ( pivot < 16 ) { break; }
        }
        if ( i <= pivot ) { return; }
        const j = this.promoted % pivot;
        //console.debug('FilterBucket.promote(): promoted %d to %d', i, j);
        const f = filters[j];
        filters[j] = filters[i];
        filters[i] = f;
        this.promoted += 1;
    }

    static reset() {
        FilterBucket.trieContainer.reset();
    }

    static optimize() {
        const trieDetails = this.trieContainer.optimize();
        vAPI.localStorage.setItem(
            'FilterBucket.trieDetails',
            JSON.stringify(trieDetails)
        );
    }

    static load(args) {
        const bucket = new FilterBucket();
        const compiledFilters = args[1];
        const filters = bucket.filters;
        for ( let i = 0, n = compiledFilters.length; i < n; i++ ) {
            filters[i] = filterFromCompiledData(compiledFilters[i]);
        }
        if ( Array.isArray(args[2]) ) {
            bucket.plainPrefix1Trie = FilterBucket.trieContainer.createOne(args[2]);
        }
        if ( Array.isArray(args[3]) ) {
            bucket.plainHnAnchoredTrie = FilterBucket.trieContainer.createOne(args[3]);
        }
        return bucket;
    }
};

FilterBucket.prototype.f = null;
FilterBucket.prototype.promoted = 0;

FilterBucket.prototype.plainPrefix1Id = FilterPlainPrefix1.fid;
FilterBucket.prototype.plainPrefix1Count = 0;
FilterBucket.prototype.plainPrefix1Trie = null;
FilterBucket.prototype.plainPrefix1Filter = new FilterPlainPrefix1('');

FilterBucket.prototype.plainHnAnchoredId = FilterPlainHnAnchored.fid;
FilterBucket.prototype.plainHnAnchoredCount = 0;
FilterBucket.prototype.plainHnAnchoredTrie = null;
FilterBucket.prototype.plainHnAnchoredFilter = new FilterPlainHnAnchored('');

FilterBucket.trieContainer = (function() {
    let trieDetails;
    try {
        trieDetails = JSON.parse(
            vAPI.localStorage.getItem('FilterBucket.trieDetails')
        );
    } catch(ex) {
    }
    return new STrieContainer(trieDetails);
})();

registerFilterClass(FilterBucket);

/******************************************************************************/
/******************************************************************************/

const FilterParser = function() {
    this.cantWebsocket = vAPI.cantWebsocket;
    this.reBadDomainOptChars = /[*+?^${}()[\]\\]/;
    this.reHostnameRule1 = /^[0-9a-z][0-9a-z.-]*[0-9a-z]$/i;
    this.reHostnameRule2 = /^[0-9a-z][0-9a-z.-]*[0-9a-z]\^?$/i;
    this.reCleanupHostnameRule2 = /\^$/g;
    this.reCanTrimCarets1 = /^[^*]*$/;
    this.reCanTrimCarets2 = /^\^?[^^]+[^^][^^]+\^?$/;
    this.reHasUppercase = /[A-Z]/;
    this.reIsolateHostname = /^(\*?\.)?([^\x00-\x24\x26-\x2C\x2F\x3A-\x5E\x60\x7B-\x7F]+)(.*)/;
    this.reHasUnicode = /[^\x00-\x7F]/;
    this.reWebsocketAny = /^ws[s*]?(?::\/?\/?)?\*?$/;
    this.reBadCSP = /(?:^|;)\s*report-(?:to|uri)\b/;
    this.reIsWildcarded = /[\^\*]/;
    this.domainOpt = '';
    this.noTokenHash = µb.urlTokenizer.tokenHashFromString('*');
    this.unsupportedTypeBit = this.bitFromType('unsupported');
    // All network request types to bitmap
    //   bring origin to 0 (from 4 -- see typeNameToTypeValue)
    //   left-shift 1 by the above-calculated value
    //   subtract 1 to set all type bits
    this.allNetRequestTypeBits = (1 << (otherTypeBitValue >>> 4)) - 1;
    this.reset();
};

/******************************************************************************/

// https://github.com/gorhill/uBlock/issues/1493
//   Transpose `ping` into `other` for now.

FilterParser.prototype.toNormalizedType = {
            'beacon': 'other',
               'css': 'stylesheet',
              'data': 'data',
               'doc': 'main_frame',
          'document': 'main_frame',
          'elemhide': 'generichide',
              'font': 'font',
             'frame': 'sub_frame',
      'genericblock': 'unsupported',
       'generichide': 'generichide',
             'image': 'image',
       'inline-font': 'inline-font',
     'inline-script': 'inline-script',
             'media': 'media',
            'object': 'object',
 'object-subrequest': 'object',
             'other': 'other',
              'ping': 'other',
          'popunder': 'popunder',
             'popup': 'popup',
            'script': 'script',
        'stylesheet': 'stylesheet',
       'subdocument': 'sub_frame',
               'xhr': 'xmlhttprequest',
    'xmlhttprequest': 'xmlhttprequest',
            'webrtc': 'unsupported',
         'websocket': 'websocket'
};

/******************************************************************************/

FilterParser.prototype.reset = function() {
    this.action = BlockAction;
    this.anchor = 0;
    this.badFilter = false;
    this.dataType = undefined;
    this.dataStr = undefined;
    this.elemHiding = false;
    this.f = '';
    this.firstParty = false;
    this.thirdParty = false;
    this.party = AnyParty;
    this.fopts = '';
    this.hostnamePure = false;
    this.domainOpt = '';
    this.isRegex = false;
    this.raw = '';
    this.redirect = false;
    this.token = '*';
    this.tokenHash = this.noTokenHash;
    this.tokenBeg = 0;
    this.types = 0;
    this.important = 0;
    this.wildcarded = false;
    this.unsupported = false;
    return this;
};

/******************************************************************************/

FilterParser.prototype.bitFromType = function(type) {
    return 1 << ((typeNameToTypeValue[type] >>> 4) - 1);
};

/******************************************************************************/

// https://github.com/chrisaljoudi/uBlock/issues/589
// Be ready to handle multiple negated types

FilterParser.prototype.parseTypeOption = function(raw, not) {
    var typeBit = this.bitFromType(this.toNormalizedType[raw]);

    if ( !not ) {
        this.types |= typeBit;
        return;
    }

    // Non-discrete network types can't be negated.
    if ( (typeBit & this.allNetRequestTypeBits) === 0 ) {
        return;
    }

    // Negated type: set all valid network request type bits to 1
    if (
        (typeBit & this.allNetRequestTypeBits) !== 0 &&
        (this.types & this.allNetRequestTypeBits) === 0
    ) {
        this.types |= this.allNetRequestTypeBits;
    }
    this.types &= ~typeBit;
};

/******************************************************************************/

FilterParser.prototype.parsePartyOption = function(firstParty, not) {
    if ( firstParty ) {
        not = !not;
    }
    if ( not ) {
        this.firstParty = true;
        this.party = this.thirdParty ? AnyParty : FirstParty;
    } else {
        this.thirdParty = true;
        this.party = this.firstParty ? AnyParty : ThirdParty;
    }
};

/******************************************************************************/

FilterParser.prototype.parseDomainOption = function(s) {
    if ( this.reHasUnicode.test(s) ) {
        const hostnames = s.split('|');
        let i = hostnames.length;
        while ( i-- ) {
            if ( this.reHasUnicode.test(hostnames[i]) ) {
                hostnames[i] = punycode.toASCII(hostnames[i]);
            }
        }
        s = hostnames.join('|');
    }
    if ( this.reBadDomainOptChars.test(s) ) { return ''; }
    return s;
};

/******************************************************************************/

FilterParser.prototype.parseOptions = function(s) {
    this.fopts = s;
    var opts = s.split(',');
    var opt, not;
    for ( var i = 0; i < opts.length; i++ ) {
        opt = opts[i];
        not = opt.startsWith('~');
        if ( not ) {
            opt = opt.slice(1);
        }
        if ( opt === 'third-party' || opt === '3p' ) {
            this.parsePartyOption(false, not);
            continue;
        }
        // https://issues.adblockplus.org/ticket/616
        // `generichide` concept already supported, just a matter of
        // adding support for the new keyword.
        if ( opt === 'elemhide' || opt === 'generichide' ) {
            if ( not === false ) {
                this.parseTypeOption('generichide', false);
                continue;
            }
            this.unsupported = true;
            break;
        }
        // Test before handling all other types.
        if ( opt.startsWith('redirect=') ) {
            if ( this.action === BlockAction ) {
                this.redirect = true;
                continue;
            }
            this.unsupported = true;
            break;
        }
        if ( this.toNormalizedType.hasOwnProperty(opt) ) {
            this.parseTypeOption(opt, not);
            continue;
        }
        // https://github.com/gorhill/uBlock/issues/2294
        // Detect and discard filter if domain option contains nonsensical
        // characters.
        if ( opt.startsWith('domain=') ) {
            this.domainOpt = this.parseDomainOption(opt.slice(7));
            if ( this.domainOpt === '' ) {
                this.unsupported = true;
                break;
            }
            continue;
        }
        if ( opt === 'important' ) {
            this.important = Important;
            continue;
        }
        if ( opt === 'first-party' || opt === '1p' ) {
            this.parsePartyOption(true, not);
            continue;
        }
        if ( opt.startsWith('csp=') ) {
            if ( opt.length > 4 && this.reBadCSP.test(opt) === false ) {
                this.parseTypeOption('data', not);
                this.dataType = 'csp';
                this.dataStr = opt.slice(4).trim();
            }
            continue;
        }
        if ( opt === 'csp' && this.action === AllowAction ) {
            this.parseTypeOption('data', not);
            this.dataType = 'csp';
            this.dataStr = '';
            continue;
        }
        // Used by Adguard, purpose is unclear -- just ignore for now.
        if ( opt === 'empty' ) {
            continue;
        }
        // https://github.com/uBlockOrigin/uAssets/issues/192
        if ( opt === 'badfilter' ) {
            this.badFilter = true;
            continue;
        }
        // Unrecognized filter option: ignore whole filter.
        this.unsupported = true;
        break;
    }
};

/*******************************************************************************

    anchor: bit vector
        0000 (0x0): no anchoring
        0001 (0x1): anchored to the end of the URL.
        0010 (0x2): anchored to the start of the URL.
        0011 (0x3): anchored to the start and end of the URL.
        0100 (0x4): anchored to the hostname of the URL.
        0101 (0x5): anchored to the hostname and end of the URL.

**/

FilterParser.prototype.parse = function(raw) {
    // important!
    this.reset();

    var s = this.raw = raw;

    // plain hostname? (from HOSTS file)
    if ( this.reHostnameRule1.test(s) ) {
        this.f = s;
        this.hostnamePure = true;
        this.anchor |= 0x4;
        return this;
    }

    // element hiding filter?
    var pos = s.indexOf('#');
    if ( pos !== -1 ) {
        var c = s.charAt(pos + 1);
        if ( c === '#' || c === '@' ) {
            console.error('static-net-filtering.js > unexpected cosmetic filters');
            this.elemHiding = true;
            return this;
        }
    }

    // block or allow filter?
    // Important: this must be executed before parsing options
    if ( s.startsWith('@@') ) {
        this.action = AllowAction;
        s = s.slice(2);
    }

    // options
    // https://github.com/gorhill/uBlock/issues/842
    // - ensure sure we are not dealing with a regex-based filter.
    // - lookup the last occurrence of `$`.
    if ( s.startsWith('/') === false || s.endsWith('/') === false ) {
        pos = s.lastIndexOf('$');
        if ( pos !== -1 ) {
            // https://github.com/gorhill/uBlock/issues/952
            //   Discard Adguard-specific `$$` filters.
            if ( s.indexOf('$$') !== -1 ) {
                this.unsupported = true;
                return this;
            }
            this.parseOptions(s.slice(pos + 1));
            // https://github.com/gorhill/uBlock/issues/2283
            //   Abort if type is only for unsupported types, otherwise
            //   toggle off `unsupported` bit.
            if ( this.types & this.unsupportedTypeBit ) {
                this.types &= ~this.unsupportedTypeBit;
                if ( this.types === 0 ) {
                    this.unsupported = true;
                    return this;
                }
            }
            s = s.slice(0, pos);
        }
    }

    // regex?
    if ( s.startsWith('/') && s.endsWith('/') && s.length > 2 ) {
        this.isRegex = true;
        this.f = s.slice(1, -1);
        // https://github.com/gorhill/uBlock/issues/1246
        // If the filter is valid, use the corrected version of the source
        // string -- this ensure reverse-lookup will work fine.
        this.f = normalizeRegexSource(this.f);
        if ( this.f === '' ) {
            console.error(
                "uBlock Origin> discarding bad regular expression-based network filter '%s': '%s'",
                raw,
                normalizeRegexSource.message
            );
            this.unsupported = true;
        }
        return this;
    }

    // hostname-anchored
    if ( s.startsWith('||') ) {
        this.anchor |= 0x4;
        s = s.slice(2);

        // convert hostname to punycode if needed
        // https://github.com/gorhill/uBlock/issues/2599
        if ( this.reHasUnicode.test(s) ) {
            var matches = this.reIsolateHostname.exec(s);
            if ( matches ) {
                s = (matches[1] !== undefined ? matches[1] : '') +
                    punycode.toASCII(matches[2]) +
                    matches[3];
                //console.debug('µBlock.staticNetFilteringEngine/FilterParser.parse():', raw, '=', s);
            }
        }

        // https://github.com/chrisaljoudi/uBlock/issues/1096
        if ( s.startsWith('^') ) {
            this.unsupported = true;
            return this;
        }

        // plain hostname? (from ABP filter list)
        // https://github.com/gorhill/uBlock/issues/1757
        // A filter can't be a pure-hostname one if there is a domain or csp
        // option present.
        if ( this.reHostnameRule2.test(s) ) {
            this.f = s.replace(this.reCleanupHostnameRule2, '');
            this.hostnamePure = true;
            return this;
        }
    }
    // left-anchored
    else if ( s.startsWith('|') ) {
        this.anchor |= 0x2;
        s = s.slice(1);
    }

    // right-anchored
    if ( s.endsWith('|') ) {
        this.anchor |= 0x1;
        s = s.slice(0, -1);
    }

    // https://github.com/gorhill/uBlock/issues/1669#issuecomment-224822448
    // remove pointless leading *.
    // https://github.com/gorhill/uBlock/issues/3034
    // - We can remove anchoring if we need to match all at the start.
    if ( s.startsWith('*') ) {
        s = s.replace(/^\*+([^%0-9a-z])/i, '$1');
        this.anchor &= ~0x6;
    }
    // remove pointless trailing *
    // https://github.com/gorhill/uBlock/issues/3034
    // - We can remove anchoring if we need to match all at the end.
    if ( s.endsWith('*') ) {
        s = s.replace(/([^%0-9a-z])\*+$/i, '$1');
        this.anchor &= ~0x1;
    }

    // nothing left?
    if ( s === '' ) {
        s = '*';
    }

    // https://github.com/gorhill/uBlock/issues/1047
    // Hostname-anchored makes no sense if matching all requests.
    if ( s === '*' ) {
        this.anchor = 0;
    }

    this.wildcarded = this.reIsWildcarded.test(s);

    // This might look weird but we gain memory footprint by not going through
    // toLowerCase(), at least on Chromium. Because copy-on-write?

    this.f = this.reHasUppercase.test(s) ? s.toLowerCase() : s;

    return this;
};

/******************************************************************************/

// Given a string, find a good token. Tokens which are too generic, i.e. very
// common with a high probability of ending up as a miss, are not
// good. Avoid if possible. This has a *significant* positive impact on
// performance.
// These "bad tokens" are collated manually.

// Hostname-anchored with no wildcard always have a token index of 0.
var reHostnameToken = /^[0-9a-z]+/;
var reGoodToken = /[%0-9a-z]{2,}/g;
var reRegexToken = /[%0-9A-Za-z]{2,}/g;
var reRegexTokenAbort = /[([]/;
var reRegexBadPrefix = /(^|[^\\]\.|[*?{}\\])$/;
var reRegexBadSuffix = /^([^\\]\.|\\[dw]|[([{}?*]|$)/;

var badTokens = new Set([
    'com',
    'google',
    'http',
    'https',
    'icon',
    'images',
    'img',
    'js',
    'net',
    'news',
    'www'
]);

FilterParser.prototype.findFirstGoodToken = function() {
    reGoodToken.lastIndex = 0;
    var s = this.f,
        matches, lpos,
        badTokenMatch = null;
    while ( (matches = reGoodToken.exec(s)) !== null ) {
        // https://github.com/gorhill/uBlock/issues/997
        // Ignore token if preceded by wildcard.
        lpos = matches.index;
        if ( lpos !== 0 && s.charCodeAt(lpos - 1) === 0x2A /* '*' */ ) {
            continue;
        }
        if ( s.charCodeAt(reGoodToken.lastIndex) === 0x2A /* '*' */ ) {
            continue;
        }
        if ( badTokens.has(matches[0]) ) {
            if ( badTokenMatch === null ) {
                badTokenMatch = matches;
            }
            continue;
        }
        return matches;
    }
    return badTokenMatch;
};

FilterParser.prototype.extractTokenFromRegex = function() {
    reRegexToken.lastIndex = 0;
    var s = this.f,
        matches, prefix;
    while ( (matches = reRegexToken.exec(s)) !== null ) {
        prefix = s.slice(0, matches.index);
        if ( reRegexTokenAbort.test(prefix) ) { return; }
        if (
            reRegexBadPrefix.test(prefix) ||
            reRegexBadSuffix.test(s.slice(reRegexToken.lastIndex))
        ) {
            continue;
        }
        this.token = matches[0].toLowerCase();
        this.tokenHash = µb.urlTokenizer.tokenHashFromString(this.token);
        this.tokenBeg = matches.index;
        if ( badTokens.has(this.token) === false ) { break; }
    }
};

/******************************************************************************/

// https://github.com/chrisaljoudi/uBlock/issues/1038
// Single asterisk will match any URL.

// https://github.com/gorhill/uBlock/issues/2781
//   For efficiency purpose, try to extract a token from a regex-based filter.

FilterParser.prototype.makeToken = function() {
    if ( this.isRegex ) {
        this.extractTokenFromRegex();
        return;
    }

    if ( this.f === '*' ) { return; }

    let matches = null;
    if ( (this.anchor & 0x4) !== 0 && this.wildcarded === false ) {
        matches = reHostnameToken.exec(this.f);
    }
    if ( matches === null ) {
        matches = this.findFirstGoodToken();
    }
    if ( matches !== null ) {
        this.token = matches[0];
        this.tokenHash = µb.urlTokenizer.tokenHashFromString(this.token);
        this.tokenBeg = matches.index;
    }
};

/******************************************************************************/
/******************************************************************************/

const FilterContainer = function() {
    this.filterParser = new FilterParser();
    this.urlTokenizer = µb.urlTokenizer;
    this.noTokenHash = this.urlTokenizer.tokenHashFromString('*');
    this.dotTokenHash = this.urlTokenizer.tokenHashFromString('.');
    this.reset();
};

/******************************************************************************/

// Reset all, thus reducing to a minimum memory footprint of the context.

FilterContainer.prototype.reset = function() {
    this.frozen = false;
    this.processedFilterCount = 0;
    this.acceptedCount = 0;
    this.rejectedCount = 0;
    this.allowFilterCount = 0;
    this.blockFilterCount = 0;
    this.discardedCount = 0;
    this.goodFilters = new Set();
    this.badFilters = new Set();
    this.categories = new Map();
    this.dataFilters = new Map();
    this.filterParser.reset();

    // This will invalidate all hn tries throughout uBO:
    filterOrigin.reset();
    FilterHostnameDict.reset();
    FilterBucket.reset();

    // Runtime registers
    this.cbRegister = undefined;
    this.thRegister = undefined;
    this.fRegister = null;

    filterClassHistogram.clear();
};

/******************************************************************************/

FilterContainer.prototype.freeze = function() {
    const filterPairId = FilterPair.fid;
    const filterBucketId = FilterBucket.fid;
    const filterDataHolderId = FilterDataHolder.fid;
    const redirectTypeValue = typeNameToTypeValue.redirect;
    const unserialize = µb.CompiledLineIO.unserialize;

    for ( const line of this.goodFilters ) {
        if ( this.badFilters.has(line) ) {
            this.discardedCount += 1;
            continue;
        }

        const args = unserialize(line);
        const bits = args[0];

        // Special cases: delegate to more specialized engines.
        // Redirect engine.
        if ( (bits & 0x1F0) === redirectTypeValue ) {
            µb.redirectEngine.fromCompiledRule(args[1]);
            continue;
        }

        // Plain static filters.
        const tokenHash = args[1];
        const fdata = args[2];

        // Special treatment: data-holding filters are stored separately
        // because they require special matching algorithm (unlike other
        // filters, ALL hits must be reported).
        if ( fdata[0] === filterDataHolderId ) {
            let entry = new FilterDataHolderEntry(bits, tokenHash, fdata);
            let bucket = this.dataFilters.get(tokenHash);
            if ( bucket !== undefined ) {
                entry.next = bucket;
            }
            this.dataFilters.set(tokenHash, entry);
            continue;
        }

        let bucket = this.categories.get(bits);
        if ( bucket === undefined ) {
            bucket = new Map();
            this.categories.set(bits, bucket);
        }
        let entry = bucket.get(tokenHash);

        if ( tokenHash === this.dotTokenHash ) {
            if ( entry === undefined ) {
                entry = new FilterHostnameDict();
                bucket.set(this.dotTokenHash, entry);
            }
            entry.add(fdata);
            continue;
        }

        if ( entry === undefined ) {
            bucket.set(tokenHash, filterFromCompiledData(fdata));
            continue;
        }
        if ( entry.fid === filterBucketId ) {
            entry.add(fdata);
            continue;
        }
        if ( entry.fid === filterPairId ) {
            bucket.set(
                tokenHash,
                entry.upgrade(filterFromCompiledData(fdata))
            );
            continue;
        }
        bucket.set(
            tokenHash,
            new FilterPair(entry, filterFromCompiledData(fdata))
        );
    }

    this.filterParser.reset();
    this.goodFilters = new Set();
    filterOrigin.optimize();
    FilterHostnameDict.optimize();
    FilterBucket.optimize();
    this.frozen = true;
};

/******************************************************************************/

// This is necessary for when the filtering engine readiness will depend
// on asynchronous operations (ex.: when loading a wasm module).

FilterContainer.prototype.readyToUse = function() {
    return Promise.resolve();
};

/******************************************************************************/

FilterContainer.prototype.toSelfie = function(path) {
    const categoriesToSelfie = function(categoryMap) {
        const selfie = [];
        for ( const [ catbits, bucket ] of categoryMap ) {
            const tokenEntries = [];
            for ( const [ token, filter ] of bucket ) {
                tokenEntries.push([ token, filter.compile() ]);
            }
            selfie.push([ catbits, tokenEntries ]);
        }
        return selfie;
    };

    const dataFiltersToSelfie = function(dataFilters) {
        const selfie = [];
        for ( let entry of dataFilters.values() ) {
            do {
                selfie.push(entry.compile());
                entry = entry.next;
            } while ( entry !== undefined );
        }
        return selfie;
    };

    return Promise.all([
        µBlock.assets.put(
            `${path}/FilterHostnameDict.trieContainer`,
            FilterHostnameDict.trieContainer.serialize(µBlock.base128)
        ),
        µBlock.assets.put(
            `${path}/FilterBucket.trieContainer`,
            FilterBucket.trieContainer.serialize(µBlock.base128)
        ),
        µBlock.assets.put(
            `${path}/main`,
            JSON.stringify({
                processedFilterCount: this.processedFilterCount,
                acceptedCount: this.acceptedCount,
                rejectedCount: this.rejectedCount,
                allowFilterCount: this.allowFilterCount,
                blockFilterCount: this.blockFilterCount,
                discardedCount: this.discardedCount,
                categories: categoriesToSelfie(this.categories),
                dataFilters: dataFiltersToSelfie(this.dataFilters),
            })
        )
    ]);
};

/******************************************************************************/

FilterContainer.prototype.fromSelfie = function(path) {
    return Promise.all([
        µBlock.assets.get(`${path}/FilterHostnameDict.trieContainer`).then(details => {
            FilterHostnameDict.trieContainer.unserialize(
                details.content,
                µBlock.base128
            );
            return true;
        }),
        µBlock.assets.get(`${path}/FilterBucket.trieContainer`).then(details => {
            FilterBucket.trieContainer.unserialize(
                details.content,
                µBlock.base128
            );
            return true;
        }),
        µBlock.assets.get(`${path}/main`).then(details => {
            let selfie;
            try {
                selfie = JSON.parse(details.content);
            } catch (ex) {
            }
            if ( selfie instanceof Object === false ) { return false; }
            this.frozen = true;
            this.processedFilterCount = selfie.processedFilterCount;
            this.acceptedCount = selfie.acceptedCount;
            this.rejectedCount = selfie.rejectedCount;
            this.allowFilterCount = selfie.allowFilterCount;
            this.blockFilterCount = selfie.blockFilterCount;
            this.discardedCount = selfie.discardedCount;
            for ( const [ catbits, bucket ] of selfie.categories ) {
                const tokenMap = new Map();
                for ( const [ token, fdata ] of bucket ) {
                    tokenMap.set(token, filterFromCompiledData(fdata));
                }
                this.categories.set(catbits, tokenMap);
            }
            for ( const dataEntry of selfie.dataFilters ) {
                const entry = FilterDataHolderEntry.load(dataEntry);
                const bucket = this.dataFilters.get(entry.tokenHash);
                if ( bucket !== undefined ) {
                    entry.next = bucket;
                }
                this.dataFilters.set(entry.tokenHash, entry);
            }
            return true;
        }),
    ]).then(results =>
        results.reduce((acc, v) => acc && v, true)
    );
};

/******************************************************************************/

FilterContainer.prototype.compile = function(raw, writer) {
    // ORDER OF TESTS IS IMPORTANT!

    // Ignore empty lines
    const s = raw.trim();
    if ( s.length === 0 ) { return false; }

    const parsed = this.filterParser.parse(s);

    // Ignore element-hiding filters
    if ( parsed.elemHiding ) {
        return false;
    }

    // Ignore filters with unsupported options
    if ( parsed.unsupported ) {
        const who = writer.properties.get('assetKey') || '?';
        µb.logger.writeOne({
            realm: 'message',
            type: 'error',
            text: `Invalid network filter in ${who}: ${raw}`
        });
        return false;
    }

    // Pure hostnames, use more efficient dictionary lookup
    // https://github.com/chrisaljoudi/uBlock/issues/665
    // Create a dict keyed on request type etc.
    if (
        parsed.hostnamePure &&
        parsed.domainOpt === '' &&
        parsed.dataType === undefined
    ) {
        parsed.tokenHash = this.dotTokenHash;
        this.compileToAtomicFilter(parsed, parsed.f, writer);
        return true;
    }

    parsed.makeToken();

    let fdata;
    if ( parsed.isRegex ) {
        fdata = FilterRegex.compile(parsed);
    } else if ( parsed.hostnamePure ) {
        fdata = FilterPlainHostname.compile(parsed);
    } else if ( parsed.f === '*' ) {
        fdata = FilterTrue.compile();
    } else if ( parsed.anchor === 0x5 ) {
        // https://github.com/gorhill/uBlock/issues/1669
        fdata = FilterGenericHnAndRightAnchored.compile(parsed);
    } else if ( parsed.anchor === 0x4 ) {
        if (
            parsed.wildcarded === false &&
            parsed.tokenHash !== parsed.noTokenHash &&
            parsed.tokenBeg === 0
        ) {
            fdata = FilterPlainHnAnchored.compile(parsed);
        } else {
            fdata = FilterGenericHnAnchored.compile(parsed);
        }
    } else if ( parsed.wildcarded || parsed.tokenHash === parsed.noTokenHash ) {
        fdata = FilterGeneric.compile(parsed);
    } else if ( parsed.anchor === 0x2 ) {
        fdata = FilterPlainLeftAnchored.compile(parsed);
    } else if ( parsed.anchor === 0x1 ) {
        fdata = FilterPlainRightAnchored.compile(parsed);
    } else if ( parsed.anchor === 0x3 ) {
        fdata = FilterExactMatch.compile(parsed);
    } else if ( parsed.tokenBeg === 1 ) {
        fdata = FilterPlainPrefix1.compile(parsed);
    } else {
        fdata = FilterPlain.compile(parsed);
    }

    if ( parsed.domainOpt !== '' ) {
        fdata = filterOrigin.compile(parsed, fdata);
    }

    if ( parsed.dataType !== undefined ) {
        let fwrapped = fdata;
        fdata = FilterDataHolder.compile(parsed);
        fdata.push(fwrapped);
    }

    this.compileToAtomicFilter(parsed, fdata, writer);

    return true;
};

/******************************************************************************/

FilterContainer.prototype.compileToAtomicFilter = function(
    parsed,
    fdata,
    writer
) {

    // 0 = network filters
    // 1 = network filters: bad filters
    if ( parsed.badFilter ) {
        writer.select(1);
    } else {
        writer.select(0);
    }

    let descBits = parsed.action | parsed.important | parsed.party;
    let type = parsed.types;

    // Typeless
    if ( type === 0 ) {
        writer.push([ descBits, parsed.tokenHash, fdata ]);
        return;
    }

    // Specific type(s)
    let bitOffset = 1;
    do {
        if ( type & 1 ) {
            writer.push([ descBits | (bitOffset << 4), parsed.tokenHash, fdata ]);
        }
        bitOffset += 1;
        type >>>= 1;
    } while ( type !== 0 );

    // Only static filter with an explicit type can be redirected. If we reach
    // this point, it's because there is one or more explicit type.
    if ( parsed.redirect ) {
        let redirects = µb.redirectEngine.compileRuleFromStaticFilter(parsed.raw);
        if ( Array.isArray(redirects) ) {
            for ( let redirect of redirects ) {
                writer.push([ typeNameToTypeValue.redirect, redirect ]);
            }
        }
    }
};

/******************************************************************************/

FilterContainer.prototype.fromCompiledContent = function(reader) {
    // 0 = network filters
    reader.select(0);
    while ( reader.next() ) {
        this.acceptedCount += 1;
        if ( this.goodFilters.has(reader.line) ) {
            this.discardedCount += 1;
        } else {
            this.goodFilters.add(reader.line);
        }
    }

    // 1 = network filters: bad filter directives
    // Since we are going to keep bad filter fingerprints around, we ensure
    // they are "detached" from the parent string from which they are sliced.
    // We keep bad filter fingerprints around to use them when user
    // incrementally add filters (through "Block element" for example).
    reader.select(1);
    while ( reader.next() ) {
        if ( this.badFilters.has(reader.line) === false ) {
            this.badFilters.add(µb.orphanizeString(reader.line));
        }
    }
};

/******************************************************************************/

FilterContainer.prototype.matchAndFetchData = function(dataType, requestURL, out, outlog) {
    if ( this.dataFilters.size === 0 ) { return; }

    let url = this.urlTokenizer.setURL(requestURL);

    pageHostnameRegister = requestHostnameRegister = µb.URI.hostnameFromURI(url);

    // We need to visit ALL the matching filters.
    let toAddImportant = new Map(),
        toAdd = new Map(),
        toRemove = new Map();

    let tokenHashes = this.urlTokenizer.getTokens(),
        i = 0;
    while ( i < 32 ) {
        let tokenHash = tokenHashes[i++];
        if ( tokenHash === 0 ) { break; }
        let tokenOffset = tokenHashes[i++];
        let entry = this.dataFilters.get(tokenHash);
        while ( entry !== undefined ) {
            let f = entry.filter;
            if ( f.match(url, tokenOffset) === true ) {
                if ( entry.categoryBits & 0x001 ) {
                    toRemove.set(f.dataStr, entry);
                } else if ( entry.categoryBits & 0x002 ) {
                    toAddImportant.set(f.dataStr, entry);
                } else {
                    toAdd.set(f.dataStr, entry);
                }
            }
            entry = entry.next;
        }
    }
    let entry = this.dataFilters.get(this.noTokenHash);
    while ( entry !== undefined ) {
        let f = entry.filter;
        if ( f.match(url) === true ) {
            if ( entry.categoryBits & 0x001 ) {
                toRemove.set(f.dataStr, entry);
            } else if ( entry.categoryBits & 0x002 ) {
                toAddImportant.set(f.dataStr, entry);
            } else {
                toAdd.set(f.dataStr, entry);
            }
        }
        entry = entry.next;
    }

    if ( toAddImportant.size === 0 && toAdd.size === 0 ) { return; }

    // Remove entries overriden by other filters.
    for ( let key of toAddImportant.keys() ) {
        toAdd.delete(key);
        toRemove.delete(key);
    }
    for ( let key of toRemove.keys() ) {
        if ( key === '' ) {
            toAdd.clear();
            break;
        }
        toAdd.delete(key);
    }

    for ( let entry of toAddImportant ) {
        out.push(entry[0]);
        if ( outlog === undefined ) { continue; }
        let logData = entry[1].logData();
        logData.source = 'static';
        logData.result = 1;
        outlog.push(logData);
    }
    for ( let entry of toAdd ) {
        out.push(entry[0]);
        if ( outlog === undefined ) { continue; }
        let logData = entry[1].logData();
        logData.source = 'static';
        logData.result = 1;
        outlog.push(logData);
    }
    if ( outlog !== undefined ) {
        for ( let entry of toRemove.values()) {
            let logData = entry.logData();
            logData.source = 'static';
            logData.result = 2;
            outlog.push(logData);
        }
    }
};

/******************************************************************************/

// bucket: Map
// url: string

FilterContainer.prototype.matchTokens = function(bucket, url) {
    // Hostname-only filters
    let f = bucket.get(this.dotTokenHash);
    if ( f !== undefined && f.match() === true ) {
        this.thRegister = this.dotTokenHash;
        this.fRegister = f;
        return true;
    }

    const tokenHashes = this.urlTokenizer.getTokens();
    let i = 0;
    for (;;) {
        const tokenHash = tokenHashes[i];
        if ( tokenHash === 0 ) { break; }
        f = bucket.get(tokenHash);
        if ( f !== undefined && f.match(url, tokenHashes[i+1]) === true ) {
            this.thRegister = tokenHash;
            this.fRegister = f;
            return true;
        }
        i += 2;
    }

    // Untokenizable filters
    f = bucket.get(this.noTokenHash);
    if ( f !== undefined && f.match(url, 0) === true ) {
        this.thRegister = this.noTokenHash;
        this.fRegister = f;
        return true;
    }

    return false;
};

/******************************************************************************/

// Specialized handlers

// https://github.com/gorhill/uBlock/issues/1477
//   Special case: blocking-generichide filter ALWAYS exists, it is implicit --
//   thus we always first check for exception filters, then for important block
//   filter if and only if there was a hit on an exception filter.
// https://github.com/gorhill/uBlock/issues/2103
//   User may want to override `generichide` exception filters.

FilterContainer.prototype.matchStringGenericHide = function(requestURL) {
    let url = this.urlTokenizer.setURL(requestURL);

    // https://github.com/gorhill/uBlock/issues/2225
    //   Important:
    //   - `pageHostnameRegister` is used by FilterOrigin?.match().
    //   - `requestHostnameRegister` is used by FilterHostnameDict.match().
    pageHostnameRegister = requestHostnameRegister = µb.URI.hostnameFromURI(url);

    let bucket = this.categories.get(genericHideException);
    if ( !bucket || this.matchTokens(bucket, url) === false ) {
        this.fRegister = null;
        return 0;
    }

    bucket = this.categories.get(genericHideImportant);
    if ( bucket && this.matchTokens(bucket, url) ) {
        this.cbRegister = genericHideImportant;
        return 1;
    }

    this.cbRegister = genericHideException;
    return 2;
};

/******************************************************************************/

// https://github.com/chrisaljoudi/uBlock/issues/116
//   Some type of requests are exceptional, they need custom handling,
//   not the generic handling.

FilterContainer.prototype.matchStringExactType = function(fctxt, requestType) {
    // Special cases.
    if ( requestType === 'generichide' ) {
        return this.matchStringGenericHide(fctxt.url);
    }
    let type = typeNameToTypeValue[requestType];
    if ( type === undefined ) { return 0; }

    // Prime tokenizer: we get a normalized URL in return.
    let url = this.urlTokenizer.setURL(fctxt.url);

    // These registers will be used by various filters
    pageHostnameRegister = fctxt.getDocHostname();
    requestHostnameRegister = fctxt.getHostname();

    let party = fctxt.is3rdPartyToDoc() ? ThirdParty : FirstParty;
    let categories = this.categories,
        catBits, bucket;

    this.fRegister = null;

    // https://github.com/chrisaljoudi/uBlock/issues/139
    //   Test against important block filters
    catBits = BlockAnyParty | Important | type;
    if ( (bucket = categories.get(catBits)) ) {
        if ( this.matchTokens(bucket, url) ) {
            this.cbRegister = catBits;
            return 1;
        }
    }
    catBits = BlockAction | Important | type | party;
    if ( (bucket = categories.get(catBits)) ) {
        if ( this.matchTokens(bucket, url) ) {
            this.cbRegister = catBits;
            return 1;
        }
    }

    // Test against block filters
    catBits = BlockAnyParty | type;
    if ( (bucket = categories.get(catBits)) ) {
        if ( this.matchTokens(bucket, url) ) {
            this.cbRegister = catBits;
        }
    }
    if ( this.fRegister === null ) {
        catBits = BlockAction | type | party;
        if ( (bucket = categories.get(catBits)) ) {
            if ( this.matchTokens(bucket, url) ) {
                this.cbRegister = catBits;
            }
        }
    }

    // If there is no block filter, no need to test against allow filters
    if ( this.fRegister === null ) {
        return 0;
    }

    // Test against allow filters
    catBits = AllowAnyParty | type;
    if ( (bucket = categories.get(catBits)) ) {
        if ( this.matchTokens(bucket, url) ) {
            this.cbRegister = catBits;
            return 2;
        }
    }
    catBits = AllowAction | type | party;
    if ( (bucket = categories.get(catBits)) ) {
        if ( this.matchTokens(bucket, url) ) {
            this.cbRegister = catBits;
            return 2;
        }
    }

    return 1;
};

/******************************************************************************/

FilterContainer.prototype.matchString = function(fctxt) {
    // https://github.com/chrisaljoudi/uBlock/issues/519
    // Use exact type match for anything beyond `other`
    // Also, be prepared to support unknown types
    let type = typeNameToTypeValue[fctxt.type];
    if ( type === undefined ) {
         type = otherTypeBitValue;
    } else if ( type === 0 || type > otherTypeBitValue ) {
        return this.matchStringExactType(fctxt, fctxt.type);
    }

    // The logic here is simple:
    //
    // block = !whitelisted &&  blacklisted
    //   or equivalent
    // allow =  whitelisted || !blacklisted

    // Statistically, hits on a URL in order of likelihood:
    // 1. No hit
    // 2. Hit on a block filter
    // 3. Hit on an allow filter
    //
    // High likelihood of "no hit" means to optimize we need to reduce as much
    // as possible the number of filters to test.
    //
    // Then, because of the order of probabilities, we should test only
    // block filters first, and test allow filters if and only if there is a
    // hit on a block filter. Since there is a high likelihood of no hit,
    // testing allow filter by default is likely wasted work, hence allow
    // filters are tested *only* if there is a (unlikely) hit on a block
    // filter.

    // Prime tokenizer: we get a normalized URL in return.
    const url = this.urlTokenizer.setURL(fctxt.url);

    // These registers will be used by various filters
    pageHostnameRegister = fctxt.getDocHostname();
    requestHostnameRegister = fctxt.getHostname();

    this.fRegister = null;

    const party = fctxt.is3rdPartyToDoc()
        ? ThirdParty
        : FirstParty;
    const categories = this.categories;
    let catBits, bucket;

    // https://github.com/chrisaljoudi/uBlock/issues/139
    // Test against important block filters.
    // The purpose of the `important` option is to reverse the order of
    // evaluation. Normally, it is "evaluate block then evaluate allow", with
    // the `important` property it is "evaluate allow then evaluate block".
    catBits = BlockAnyTypeAnyParty | Important;
    if ( (bucket = categories.get(catBits)) ) {
        if ( this.matchTokens(bucket, url) ) {
            this.cbRegister = catBits;
            return 1;
        }
    }
    catBits = BlockAnyType | Important | party;
    if ( (bucket = categories.get(catBits)) ) {
        if ( this.matchTokens(bucket, url) ) {
            this.cbRegister = catBits;
            return 1;
        }
    }
    catBits = BlockAnyParty | Important | type;
    if ( (bucket = categories.get(catBits)) ) {
        if ( this.matchTokens(bucket, url) ) {
            this.cbRegister = catBits;
            return 1;
        }
    }
    catBits = BlockAction | Important | type | party;
    if ( (bucket = categories.get(catBits)) ) {
        if ( this.matchTokens(bucket, url) ) {
            this.cbRegister = catBits;
            return 1;
        }
    }

    // Test against block filters
    catBits = BlockAnyTypeAnyParty;
    if ( (bucket = categories.get(catBits)) ) {
        if ( this.matchTokens(bucket, url) ) {
            this.cbRegister = catBits;
        }
    }
    if ( this.fRegister === null ) {
        catBits = BlockAnyType | party;
        if ( (bucket = categories.get(catBits)) ) {
            if ( this.matchTokens(bucket, url) ) {
                this.cbRegister = catBits;
            }
        }
        if ( this.fRegister === null ) {
            catBits = BlockAnyParty | type;
            if ( (bucket = categories.get(catBits)) ) {
                if ( this.matchTokens(bucket, url) ) {
                    this.cbRegister = catBits;
                }
            }
            if ( this.fRegister === null ) {
                catBits = BlockAction | type | party;
                if ( (bucket = categories.get(catBits)) ) {
                    if ( this.matchTokens(bucket, url) ) {
                        this.cbRegister = catBits;
                    }
                }
            }
        }
    }

    // If there is no block filter, no need to test against allow filters
    if ( this.fRegister === null ) {
        return 0;
    }

    // Test against allow filters
    catBits = AllowAnyTypeAnyParty;
    if ( (bucket = categories.get(catBits)) ) {
        if ( this.matchTokens(bucket, url) ) {
            this.cbRegister = catBits;
            return 2;
        }
    }
    catBits = AllowAnyType | party;
    if ( (bucket = categories.get(catBits)) ) {
        if ( this.matchTokens(bucket, url) ) {
            this.cbRegister = catBits;
            return 2;
        }
    }
    catBits = AllowAnyParty | type;
    if ( (bucket = categories.get(catBits)) ) {
        if ( this.matchTokens(bucket, url) ) {
            this.cbRegister = catBits;
            return 2;
        }
    }
    catBits = AllowAction | type | party;
    if ( (bucket = categories.get(catBits)) ) {
        if ( this.matchTokens(bucket, url) ) {
            this.cbRegister = catBits;
            return 2;
        }
    }

    return 1;
};

/******************************************************************************/

FilterContainer.prototype.toLogData = function() {
    if ( this.fRegister === null ) { return; }
    const logData = toLogDataInternal(this.cbRegister, this.thRegister, this.fRegister);
    logData.source = 'static';
    logData.tokenHash = this.thRegister;
    logData.result = this.fRegister === null ? 0 : (this.cbRegister & 1 ? 2 : 1);
    return logData;
};

/******************************************************************************/

FilterContainer.prototype.getFilterCount = function() {
    return this.acceptedCount - this.discardedCount;
};

/******************************************************************************/

// action: 1=test, 2=record

FilterContainer.prototype.benchmark = function(action) {
    µb.loadBenchmarkDataset().then(requests => {
        if ( Array.isArray(requests) === false || requests.length === 0 ) {
            console.info('No requests found to benchmark');
            return;
        }
        console.info(`Benchmarking staticNetFilteringEngine.matchString()...`);
        const fctxt = µb.filteringContext.duplicate();
        let expected, recorded;
        if ( action === 1 ) {
            try {
                expected = JSON.parse(
                    vAPI.localStorage.getItem('FilterContainer.benchmark.results')
                );
            } catch(ex) {
            }
        }
        if ( action === 2 ) {
            recorded = [];
        }
        const t0 = self.performance.now();
        for ( let i = 0; i < requests.length; i++ ) {
            const request = requests[i];
            fctxt.setURL(request.url);
            fctxt.setDocOriginFromURL(request.frameUrl);
            fctxt.setType(request.cpt);
            const r = this.matchString(fctxt);
            if ( recorded !== undefined ) { recorded.push(r); }
            if ( expected !== undefined && r !== expected[i] ) {
                throw 'Mismatch with reference results';
            }
        }
        const t1 = self.performance.now();
        const dur = t1 - t0;
        console.info(`Evaluated ${requests.length} requests in ${dur.toFixed(0)} ms`);
        console.info(`\tAverage: ${(dur / requests.length).toFixed(3)} ms per request`);
        if ( expected !== undefined ) {
            console.info(`\tBlocked: ${expected.reduce((n,r)=>{return r===1?n+1:n;},0)}`);
            console.info(`\tExcepted: ${expected.reduce((n,r)=>{return r===2?n+1:n;},0)}`);
        }
        if ( recorded !== undefined ) {
            vAPI.localStorage.setItem(
                'FilterContainer.benchmark.results',
                JSON.stringify(recorded)
            );
        }
    });
    return 'ok';
};

/******************************************************************************/

FilterContainer.prototype.bucketHistogram = function() {
    const results = [];
    for ( const [ bits, category ] of this.categories ) {
        for ( const [ th, f ] of category ) {
            if ( f instanceof FilterBucket === false ) { continue; }
            const token = µBlock.urlTokenizer.stringFromTokenHash(th);
            results.push({ bits, token, size: f.size, f });
        }
    }
    results.sort((a, b) => {
        return b.size - a.size;
    });
    console.log(results);
};

/******************************************************************************/

return new FilterContainer();

/******************************************************************************/

})();
