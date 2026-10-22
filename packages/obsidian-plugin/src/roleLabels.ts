// Chinese labels for bookmap divisions in the outline ("第 1 章", "前言").
// Wording follows the VS Code DITA Viewer's zh-cn bundle. Other languages get
// the core's English labels.

import type { RoleLabelFormatter } from '@dita-viewer/core';

const ZH_ROLES: Record<string, string> = {
  Preface: '前言',
  Notices: '声明',
  'Draft Intro': '草稿导语',
  Dedication: '献词',
  Colophon: '后记',
  Abstract: '摘要',
  Amendments: '修订记录',
  Glossary: '术语表',
};

const formatZh: RoleLabelFormatter = ({ tagName, role, ordinal }) => {
  if (ordinal) {
    if (tagName === 'chapter') return `第 ${ordinal} 章`;
    if (tagName === 'part') return `第 ${ordinal} 部分`;
    if (tagName === 'appendix') return `附录 ${ordinal}`;
  }
  const base = tagName === 'chapter' ? '章' : tagName === 'part' ? '部分' : tagName === 'appendix' ? '附录' : undefined;
  return base ?? ZH_ROLES[role] ?? role;
};

/** Formatter for the UI language (an Obsidian/moment locale such as "zh-cn"), or undefined for the default English. */
export function roleFormatFor(locale: string | undefined): RoleLabelFormatter | undefined {
  return locale && /^zh/i.test(locale) ? formatZh : undefined;
}

export function outlineLabel(locale: string | undefined): string {
  return locale && /^zh/i.test(locale) ? '文档大纲' : 'Document outline';
}

/** The words a book adds to the topics it merges, for the UI language. */
export function bookLabels(locale: string | undefined): { missingTopic: string } {
  return { missingTopic: locale && /^zh/i.test(locale) ? '找不到主题' : 'Missing topic' };
}

/** The words site view adds to a single page and to an empty map. */
export function siteLabels(locale: string | undefined): { missingTopic: string; noTopics: string } {
  const zh = locale && /^zh/i.test(locale);
  return {
    missingTopic: zh ? '找不到主题' : 'Missing topic',
    noTopics: zh ? '这张映射没有主题。' : 'This map has no topics.',
  };
}
