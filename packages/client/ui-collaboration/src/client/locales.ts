/** `collaboration` namespace dictionaries. */

/** Dictionary namespace owned by this plugin. */
export const NS = 'collaboration'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'scope.aria': '切换个人或项目空间',
  'scope.personal': '个人空间',
  'scope.projects': '项目空间',
  'scope.readOnly': '只读',
  'scope.readWrite': '可编辑',
  'scope.switching': '正在切换空间',
  'scope.failed': '空间切换失败，请重试',
  'newConversation.label': '新对话可见范围',
  'visibility.project': '项目公开',
  'visibility.project.description': '项目成员均可查看和参与',
  'visibility.private': '仅自己',
  'visibility.private.description': '只有创建者可以查看',
  'conversation.aria': '管理对话共享范围',
  'conversation.loading': '正在读取协作信息',
  'conversation.title': '对话共享',
  'conversation.creator': '创建者：{name}',
  'conversation.participants': '参与者（{count}）',
  'conversation.contributions': '{count} 次参与',
  'conversation.noParticipants': '暂无其他参与者',
  'conversation.manageDenied': '只有创建者可以更改共享范围',
  'conversation.visibilityLocked': '已有其他成员参与，不能改为仅自己',
  'conversation.updateFailed': '共享范围更新失败，请重试',
  'readonly.title': '只读项目',
  'readonly.body': '当前成员权限不允许修改此对话。',
} as const

/** English dictionary, key-identical to the Chinese source of truth. */
export const en: Record<CollaborationKey, string> = {
  'scope.aria': 'Switch personal or project scope',
  'scope.personal': 'Personal',
  'scope.projects': 'Projects',
  'scope.readOnly': 'Read only',
  'scope.readWrite': 'Can edit',
  'scope.switching': 'Switching scope',
  'scope.failed': 'Could not switch scope. Try again.',
  'newConversation.label': 'New conversation visibility',
  'visibility.project': 'Shared with project',
  'visibility.project.description': 'Project members can view and participate',
  'visibility.private': 'Only me',
  'visibility.private.description': 'Only the creator can view it',
  'conversation.aria': 'Manage conversation sharing',
  'conversation.loading': 'Loading collaboration details',
  'conversation.title': 'Conversation sharing',
  'conversation.creator': 'Created by {name}',
  'conversation.participants': 'Participants ({count})',
  'conversation.contributions': '{count} contributions',
  'conversation.noParticipants': 'No other participants yet',
  'conversation.manageDenied': 'Only the creator can change visibility',
  'conversation.visibilityLocked': 'A participant has contributed, so this conversation cannot become private',
  'conversation.updateFailed': 'Could not update visibility. Try again.',
  'readonly.title': 'Read-only project',
  'readonly.body': 'Your project role does not allow changes to this conversation.',
}

/** Key domain of the `collaboration` namespace (zh is the source of truth). */
export type CollaborationKey = keyof typeof zh
