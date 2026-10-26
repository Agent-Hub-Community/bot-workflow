// Template for groups.private.mjs, which holds the pipeline's private values and is never committed:
//   cp groups.example.mjs groups.private.mjs
// then replace every placeholder. chat-groups.mjs refuses placeholders when it loads groups.private.mjs.

// WeChat chatroom username of each group in the newspaper's lib/groups.mjs, keyed by group id. `wx sessions` lists
// them; they look like <digits>@chatroom.
export const chatrooms = {
  'group-1': 'GROUP-1-CHATROOM-ID@chatroom',
  'group-2': 'GROUP-2-CHATROOM-ID@chatroom',
  'group-3': 'GROUP-3-CHATROOM-ID@chatroom',
  'group-4': 'GROUP-4-CHATROOM-ID@chatroom',
  'group-5': 'GROUP-5-CHATROOM-ID@chatroom',
  'group-6': 'GROUP-6-CHATROOM-ID@chatroom',
  'group-7': 'GROUP-7-CHATROOM-ID@chatroom',
  'group-8': 'GROUP-8-CHATROOM-ID@chatroom',
};

// Member hashes (memberKey in the newspaper's lib/activity.mjs) of accounts that post the daily updates and relay outside links
// into every group. collect-library-candidates.mjs writes them into candidates.json, and the public
// assemble-library.mjs then counts their posts as relays, not member shares. Leave empty if there is none.
export const libraryOperators = [];
