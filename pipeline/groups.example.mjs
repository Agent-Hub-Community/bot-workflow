// Template for groups.private.mjs, which holds the pipeline's private chatroom IDs and is never committed:
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
