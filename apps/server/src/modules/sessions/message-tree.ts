import type { StoredMessage } from "../../db/repositories/types.js";

/**
 * 会话消息版本树的纯函数(docs 14 §7.2)。不碰 DB。
 *
 * 概念:每个 slot 是对话里的一个"位置",同一 slot 的多条消息 = 该位置的 v1/v2/v3;
 * parent_id 让消息构成一棵树;active_leaf_id 指出当前显示的是哪条分支的叶子。
 */

/**
 * 激活链:从叶子沿 parent_id 上溯,返回正序(最早在前)。
 *
 * @param activeLeafId 为空(老会话)→ 退化成"取时间上最后一条",与 R2 之前行为一致。
 *   指向不存在的 id → 返回空(不抛,读路径自己处理)。
 */
export const buildActiveChain = (
  rows: readonly StoredMessage[],
  activeLeafId: string | null
): readonly StoredMessage[] => {
  if (rows.length === 0) {
    return [];
  }

  // S7 隔离红线:子代理进程消息挂 parent_tool_call_id,不属主链。这里先滤掉,
  // 否则它们(以及它们之间可能存在的 parent 链接)会被误拼进主上下文 ——
  // 子代理的中间过程会无声污染主模型。主链 = parent_tool_call_id IS NULL。
  const mainRows = rows.filter((row) => row.parentToolCallId === null);

  if (mainRows.length === 0) {
    return [];
  }

  const byId = new Map(mainRows.map((row) => [row.id, row]));

  if (activeLeafId === null) {
    // 退化路径:时间序最后一条(= 数组末尾,rows 按 createdAt,rowid 升序)。
    const last = mainRows[mainRows.length - 1]!;
    return buildChain(byId, last.id);
  }

  const leaf = byId.get(activeLeafId);

  if (!leaf) {
    return [];
  }

  return buildChain(byId, activeLeafId);
};

/**
 * 从某条消息向下探到叶子:每层取**最新的**子节点(rows 按 createdAt,rowid 升序)。
 *
 * 切版本时用:切到 v2 不能只把指针指向 v2 —— v2 下面可能已接后续对话,
 * 用户期望"把那条分支整条恢复出来"。无子节点 → 返回自己。
 */
export const resolveLeafFrom = (
  rows: readonly StoredMessage[],
  messageId: string
): string => {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const childrenByParent = new Map<string, StoredMessage[]>();

  for (const row of rows) {
    if (row.parentId !== null) {
      const siblings = childrenByParent.get(row.parentId) ?? [];
      siblings.push(row);
      childrenByParent.set(row.parentId, siblings);
    }
  }

  let current = byId.get(messageId);
  const seen = new Set<string>();

  while (current) {
    if (seen.has(current.id)) {
      // 脏数据成环:返回走到这里为止的 id,不无限循环。
      return current.id;
    }

    seen.add(current.id);

    const children = childrenByParent.get(current.id) ?? [];
    const next = children[children.length - 1]; // 最新子节点(按 createdAt,rowid 升序)

    if (!next) {
      return current.id;
    }

    current = next;
  }

  // messageId 不存在 → 返回它本身(调用方拿不到会 404)。
  return messageId;
};

/** 从 leafId 沿 parent 上溯,返回正序链表。内部用 seen 防环。 */
const buildChain = (
  byId: Map<string, StoredMessage>,
  leafId: string
): readonly StoredMessage[] => {
  const chain: StoredMessage[] = [];
  const seen = new Set<string>();
  let current = byId.get(leafId);

  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    chain.unshift(current);
    current = current.parentId !== null ? byId.get(current.parentId) : undefined;
  }

  return chain;
};
