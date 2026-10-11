import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Tree from './Tree.ts';

type TestMessage = {
  id: string;
  parent_message_id: string | null;
  role: 'user' | 'assistant';
};

describe('conversation message tree migration contract', () => {
  const messages: TestMessage[] = [
    { id: 'user-root', parent_message_id: null, role: 'user' },
    {
      id: 'assistant-original',
      parent_message_id: 'user-root',
      role: 'assistant',
    },
    {
      id: 'user-edited',
      parent_message_id: 'user-root',
      role: 'user',
    },
    {
      id: 'assistant-retry',
      parent_message_id: 'user-edited',
      role: 'assistant',
    },
    {
      id: 'assistant-restored-copy',
      parent_message_id: 'user-root',
      role: 'assistant',
    },
  ];

  it('derives the same active branch solely from the persisted leaf', () => {
    const tree = new Tree(messages);
    assert.deepEqual(
      tree.getPath('assistant-retry').map((message) => message.id),
      ['user-root', 'user-edited', 'assistant-retry'],
    );
  });

  it('keeps retry, edited, and restored versions as navigable siblings', () => {
    const tree = new Tree(messages);
    assert.deepEqual(
      tree.allNodes
        .get('assistant-original')
        ?.siblings.map((message) => message.id),
      ['assistant-original', 'user-edited', 'assistant-restored-copy'],
    );
    assert.deepEqual(
      tree.getPath('assistant-restored-copy').map((message) => message.id),
      ['user-root', 'assistant-restored-copy'],
    );
  });
});
