export const DEFAULT_CONVERSATION_TITLES = [
  'New Conversation',
  'New conversation',
  'New Creation',
  'New Chat',
  'Chat',
  'Untitled',
  'Conversation',
];

export function modelTitle(value?: string): string {
  return (value ?? '')
    .trim()
    .replace(
      /^(?:please\s+)?(?:create|build|generate|design|make)\s+(?:(?:a|an|the)\s+)?/i,
      '',
    )
    .replace(/^(?:请)?(?:创建|生成|制作|设计|构建)(?:一个|一款|一套)?\s*/, '')
    .trim()
    .slice(0, 80);
}

export function modelFilename(
  title?: string,
  conversationTitle?: string,
): string {
  const source =
    modelTitle(title) ||
    (conversationTitle &&
    !DEFAULT_CONVERSATION_TITLES.includes(conversationTitle)
      ? modelTitle(conversationTitle)
      : '') ||
    'parametric-model';
  const safe = source
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{Cc}<>:"/\\|?*]/gu, '-')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[. -]+|[. -]+$/g, '')
    .slice(0, 100)
    .replace(/[. -]+$/g, '');
  if (!safe) return 'parametric-model';
  return /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(safe)
    ? `model-${safe}`
    : safe;
}
