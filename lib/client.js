/* dsh-session-pruner client bundle — 设置面板卡片（手写，无构建链）。
 * 结构对齐官方 PluginCard：li 卡片默认折叠 → header(名称+描述+chevron)
 * → body(ValueField 字段 + footer: discard/save)。样式抄官方
 * fields.module.css / PluginCard.module.css 的 CSS 变量与尺寸。
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-pruner',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    const { createElement: h, useEffect, useState } = require('react');
    require('react/jsx-runtime');

    const NS = 'dsh-session-pruner';
    const ALIAS = (k, fb) => 'var(--dsw-alias-' + k + ', ' + fb + ')';

    // 官方 CSS 变量映射（同色板）
    const V = {
      border: ALIAS('border-l2', 'rgba(196,211,232,0.16)'),
      bgCard: ALIAS('bg-layer-3', '#1d2735'),
      bgOpen: ALIAS('bg-layer-2', '#1a2331'),
      bgModule: ALIAS('bg-module-platform', '#232f40'),
      text1: ALIAS('label-primary', '#f2f6fc'),
      text2: ALIAS('label-secondary', '#9daabd'),
      text3: ALIAS('label-tertiary', '#718096'),
      dimmed: ALIAS('label-dimmed', 'rgba(196,211,232,0.31)'),
      error: ALIAS('label-error', '#ff8592'),
    };

    /* ---------- 官方 ValueField ---------- */
    function ValueField(props) {
      const { id, label, hint, invalidText, text, onEdit, numeric, disabled } = props;
      const input = h('input', {
        id,
        type: 'text',
        inputMode: numeric ? 'numeric' : undefined,
        value: text,
        disabled,
        onChange: (e) => onEdit(e.target.value),
        style: {
          border: '1px solid ' + (props.invalid ? V.error : V.border),
          background: V.bgCard, height: 34, font: 'inherit', color: V.text1,
          borderRadius: 8, padding: '0 12px', fontSize: 13, lineHeight: 1.5,
          outline: 'none',
        },
      });
      return h('div', { style: { flexDirection: 'column', gap: 6, padding: '12px 0', display: 'flex' } },
        h('div', { style: { alignItems: 'center', gap: 8, display: 'flex' } },
          h('label', { htmlFor: id, style: { minWidth: 0, color: V.text1, flex: 1, fontSize: 13, fontWeight: 500, lineHeight: 1.5 } }, label),
          props.overridden ? h('span', { style: { whiteSpace: 'nowrap', background: V.bgModule, color: V.text2, borderRadius: 999, padding: '1px 8px', fontSize: 11, fontWeight: 500, lineHeight: '17px' } }, '已覆盖') : null,
          props.overridden ? h('button', { type: 'button', onClick: props.onReset, disabled, style: { font: 'inherit', color: V.text2, cursor: 'pointer', background: '0 0', border: 'none', padding: 0, fontSize: 12, lineHeight: 1.5 } }, '重置') : null),
        input,
        h('p', { style: { color: props.invalid ? V.error : V.text3, margin: 0, fontSize: 12, lineHeight: 1.5 } }, props.invalid ? invalidText : hint));
    }

    /* ---------- 卡片：对齐官方 PluginCard ---------- */
    function LifecycleCard(props) {
      const scope = props.scope;
      const [snap, setSnap] = useState(() => scope.getSnapshot());
      const [open, setOpen] = useState(false); // 官方默认折叠
      const [draft, setDraft] = useState(null);
      const [saving, setSaving] = useState(false);
      const [failed, setFailed] = useState(false);
      useEffect(() => scope.subscribe(() => setSnap(scope.getSnapshot())), [scope]);

      const value = snap.value || {};
      // 各字段默认值映射（与 host Config schema 的 default 保持一致）：
      // intervalMinutes 60 / maxSessions 400 / uiRefreshSeconds 30 / archiveHours 24 /
      // archiveMode archive / continuableIdleDays 0 / mainIdleDays 0 / oneShotMinAgeMinutes 3
      const DEF = {
        intervalMinutes: 60,
        maxSessions: 400,
        uiRefreshSeconds: 30,
        archiveHours: 24,
        continuableIdleDays: 0,
        mainIdleDays: 0,
        oneShotMinAgeMinutes: 3,
      };
      const draftFromValue = (v) => ({
        intervalMinutes: String(v.intervalMinutes ?? DEF.intervalMinutes),
        maxSessions: String(v.maxSessions ?? DEF.maxSessions),
        cleanMain: !!v.cleanMain,
        uiRefreshSeconds: String(v.uiRefreshSeconds ?? DEF.uiRefreshSeconds),
        archiveHours: String(v.archiveHours ?? DEF.archiveHours),
        archiveMode: v.archiveMode === 'delete' ? 'delete' : 'archive',
        continuableIdleDays: String(v.continuableIdleDays ?? DEF.continuableIdleDays),
        mainIdleDays: String(v.mainIdleDays ?? DEF.mainIdleDays),
        oneShotMinAgeMinutes: String(v.oneShotMinAgeMinutes ?? DEF.oneShotMinAgeMinutes),
      });
      useEffect(() => {
        setDraft(draftFromValue(value));
      }, [snap.value, snap.revision]);

      if (!draft) return null;
      const writable = !!snap.writable && snap.status === 'ready';
      const dirty =
        Number(draft.intervalMinutes) !== (value.intervalMinutes ?? DEF.intervalMinutes) ||
        Number(draft.maxSessions) !== (value.maxSessions ?? DEF.maxSessions) ||
        !!draft.cleanMain !== !!value.cleanMain ||
        Number(draft.uiRefreshSeconds) !== (value.uiRefreshSeconds ?? DEF.uiRefreshSeconds) ||
        Number(draft.archiveHours) !== (value.archiveHours ?? DEF.archiveHours) ||
        (draft.archiveMode || 'archive') !== (value.archiveMode === 'delete' ? 'delete' : 'archive') ||
        Number(draft.continuableIdleDays) !== (value.continuableIdleDays ?? DEF.continuableIdleDays) ||
        Number(draft.mainIdleDays) !== (value.mainIdleDays ?? DEF.mainIdleDays) ||
        Number(draft.oneShotMinAgeMinutes) !== (value.oneShotMinAgeMinutes ?? DEF.oneShotMinAgeMinutes);
      // 各字段独立校验（对应 host schema 的 min/max）
      const checks = {
        intervalMinutes: (n) => n >= 1 && n <= 1440,
        maxSessions: (n) => n >= 50 && n <= 100000,
        uiRefreshSeconds: (n) => n >= 5 && n <= 600,
        archiveHours: (n) => n >= 1 && n <= 720,
        continuableIdleDays: (n) => n >= 0 && n <= 365,
        mainIdleDays: (n) => n >= 0 && n <= 365,
        oneShotMinAgeMinutes: (n) => n >= 0 && n <= 60,
      };
      const numOk = (f) => checks[f](Number(draft[f]));
      const invalid = !numOk('intervalMinutes') || !numOk('maxSessions') || !numOk('uiRefreshSeconds') ||
        !numOk('archiveHours') || !numOk('continuableIdleDays') || !numOk('mainIdleDays') ||
        !numOk('oneShotMinAgeMinutes');

      const save = async () => {
        if (invalid || !dirty) return;
        setSaving(true); setFailed(false);
        try {
          await scope.set('intervalMinutes', Number(draft.intervalMinutes));
          await scope.set('maxSessions', Number(draft.maxSessions));
          await scope.set('cleanMain', !!draft.cleanMain);
          await scope.set('uiRefreshSeconds', Number(draft.uiRefreshSeconds));
          await scope.set('archiveHours', Number(draft.archiveHours));
          await scope.set('archiveMode', draft.archiveMode === 'delete' ? 'delete' : 'archive');
          await scope.set('continuableIdleDays', Number(draft.continuableIdleDays));
          await scope.set('mainIdleDays', Number(draft.mainIdleDays));
          await scope.set('oneShotMinAgeMinutes', Number(draft.oneShotMinAgeMinutes));
        } catch (e) {
          // S9 修复：保存失败时重读服务端最新值并重置草稿，避免界面残留半新半旧配置
          setFailed(true);
          console.error('[dsh-session-pruner] save failed', e);
          try {
            const fresh = scope.getSnapshot && scope.getSnapshot();
            if (fresh) setDraft(draftFromValue(fresh.value || {}));
          } catch (e2) { /* 重读失败保持现状 */ }
        } finally {
          setSaving(false);
        }
      };
      const discard = () => {
        setDraft(draftFromValue(value));
      };

      const field = (f, label, hint) =>
        h(ValueField, {
          id: 'slc-' + f,
          label, hint,
          invalidText: '数值无效',
          numeric: true,
          disabled: !writable,
          overridden: snap.user != null && snap.user[f] !== undefined,
          text: draft[f],
          invalid: !numOk(f),
          onEdit: (t) => setDraft({ ...draft, [f]: t }),
          onReset: () => setDraft({ ...draft, [f]: String(value[f] ?? DEF[f]) }),
        });

      const header = h('button', {
        type: 'button',
        'aria-expanded': open,
        onClick: () => setOpen(!open),
        style: {
          appearance: 'none', width: '100%', font: 'inherit', color: 'inherit',
          textAlign: 'left', cursor: 'pointer', background: '0 0', border: 0,
          borderRadius: 12, alignItems: 'center', gap: 12, padding: '14px 16px', display: 'flex',
        },
      },
        h('span', { style: { flexDirection: 'column', flex: 1, gap: 4, minWidth: 0, display: 'flex' } },
          h('span', { style: { color: V.text1, fontSize: 15, fontWeight: 600, lineHeight: 1.4 } }, '会话生命周期管理'),
          h('span', { style: { color: V.text3, fontSize: 13, lineHeight: 1.5 } },
            '会话生命周期：间隔 ' + (value.intervalMinutes ?? DEF.intervalMinutes) + ' 分钟 · 保底 ' + (value.maxSessions ?? DEF.maxSessions) + ' · ' + (value.cleanMain ? '含主会话' : '保留主会话'))),
        dirty ? h('span', { style: { whiteSpace: 'nowrap', background: V.bgModule, color: V.text2, borderRadius: 999, flex: 'none', padding: '1px 8px', fontSize: 11, fontWeight: 500, lineHeight: '17px' } }, '未保存') : null,
        h('span', { style: { color: V.text3, flex: 'none', transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .16s' } }, '▾'));

      const body = h('div', { style: { borderTop: '1px solid ' + V.border, margin: '0 16px', paddingBottom: 8 } },
        !writable ? h('p', { style: { color: V.text3, margin: '12px 0 0', fontSize: 12, lineHeight: 1.5 } }, '只读（memory 模式）') : null,
        field('intervalMinutes', '扫描间隔（分钟）', 'one-shot 完成后最长存活时间，保存即热加载'),
        field('maxSessions', '容量保底（会话数）', '超限按 one-shot → 可续 → 主会话 回收最旧'),
        field('uiRefreshSeconds', '界面兜底刷新间隔（秒）', 'dirty-flag 为主路径（3s 变更检测），此值为全量刷新兜底，默认 30'),
        field('archiveHours', '归档保留（小时）', '归档目录中的会话保留 N 小时后物理删除'),
        h('div', { style: { flexDirection: 'column', gap: 6, padding: '12px 0', display: 'flex', borderTop: '1px solid ' + V.border } },
          h('div', { style: { alignItems: 'center', gap: 8, display: 'flex' } },
            h('label', { style: { minWidth: 0, color: V.text1, flex: 1, fontSize: 13, fontWeight: 500, lineHeight: 1.5 } }, '归档方式'),
            h('select', {
              value: draft.archiveMode || 'archive',
              disabled: !writable,
              onChange: (e) => setDraft({ ...draft, archiveMode: e.target.value }),
              style: { border: '1px solid ' + V.border, background: V.bgCard, height: 34, color: V.text1, borderRadius: 8, padding: '0 8px', fontSize: 13 },
            },
              h('option', { value: 'archive' }, '归档（可恢复，到期删除）'),
              h('option', { value: 'delete' }, '直接删除（不可恢复）'))),
          h('p', { style: { color: V.text3, margin: 0, fontSize: 12, lineHeight: 1.5 } }, '被清理的会话按此方式处理')),
        field('continuableIdleDays', '可续子代理闲置归档（天）', '超过 N 天未活动的 continuable 子代理归档，0 = 不启用'),
        field('mainIdleDays', '主会话闲置归档（天）', '超过 N 天未活动的主会话归档，0 = 不启用'),
        field('oneShotMinAgeMinutes', 'one-shot 闲置归档阈值（分钟）', '有/无 end-seed 统一，闲置超 N 分钟即归档'),
        h('div', { style: { flexDirection: 'column', gap: 6, padding: '12px 0', display: 'flex', borderTop: '1px solid ' + V.border } },
          h('div', { style: { alignItems: 'center', gap: 8, display: 'flex' } },
            h('label', { style: { minWidth: 0, color: V.text1, flex: 1, fontSize: 13, fontWeight: 500, lineHeight: 1.5 } }, '超限时清理主会话'),
            h('input', { type: 'checkbox', checked: draft.cleanMain, disabled: !writable, onChange: (e) => setDraft({ ...draft, cleanMain: e.target.checked }), style: { width: 16, height: 16 } })),
          h('p', { style: { color: V.text3, margin: 0, fontSize: 12, lineHeight: 1.5 } }, '默认保留 main，仅超限且开启才回收')),
        h('div', { style: { borderTop: '1px solid ' + V.border, justifyContent: 'flex-end', alignItems: 'center', gap: 8, padding: '12px 0 4px', display: 'flex' } },
          failed ? h('p', { style: { minWidth: 0, color: V.error, flex: 1, margin: 0, fontSize: 12, lineHeight: 1.5 } }, '保存失败，请重试') : null,
          h('button', {
            type: 'button', onClick: discard, disabled: !dirty || saving,
            style: {
              appearance: 'none', font: 'inherit', cursor: 'pointer', border: '1px solid ' + V.border,
              color: V.text2, background: '0 0', borderRadius: 8, padding: '5px 14px', fontSize: 13, lineHeight: 1.5,
            },
          }, '放弃更改'),
          h('button', {
            type: 'button', onClick: save, disabled: !dirty || invalid || saving || !writable,
            style: {
              appearance: 'none', font: 'inherit', cursor: 'pointer', border: '1px solid transparent',
              background: V.text1, color: V.bgCard, borderRadius: 8, padding: '5px 14px', fontSize: 13, lineHeight: 1.5,
            },
          }, saving ? '保存中…' : '保存')));

      return h('li', {
        style: {
          border: '1px solid ' + (open ? V.dimmed : V.border),
          background: open ? V.bgOpen : V.bgCard,
          borderRadius: 12, listStyle: 'none',
          transition: 'border-color .16s, background .16s',
        },
      }, header, open ? body : null);
    }

    function apply(ctx) {
      ctx.slots.inject('settings.plugin.item', () => {
        const scope = ctx.settingsScope.bind({ namespace: NS });
        return ctx.slots.register({
          name: 'settings.plugin.item',
          key: NS,
          inject: () => ({ scope }),
        }, LifecycleCard);
      });

      // 会话列表同步：host 自动清理冷会话后，磁盘状态变了但 GUI 列表不感知。
      // 定时刷两套数据源——
      // 1) sessions.refreshList()（session.list RPC 读磁盘目录，轻量）：刷新
      //    主会话列表 summaries（侧边栏、计数、better-sidebar 摘要）。
      // 2) sessions.refreshSubagents(parent)（subagents.list RPC 读磁盘）：
      //    刷新每个已知父会话的子代理目录 catalogs。目录条目只在此类 RPC
      //    重查时才更新（官方目录菜单 / better-sidebar 任务管理面板），否则
      //    已归档（删除）的可续子代理条目会永远陈留在面板里。
      const refresh = async (extraParents) => {
        try {
          const svc = ctx.get && ctx.get('sessions');
          if (!svc) return;
          // 收集要刷新的父会话（并集）：
          // 1) byId 里已知子代理的父会话（含完成后仍保留的可续子代理）；
          // 2) host 归档日志携带的 parentSessionId——one-shot 归档后其父可能
          //    已不在 byId（非 durable 子代理完成即从 summaries 移除），必须
          //    靠 host 告知才能刷到它的目录，否则 better-sidebar 面板陈留；
          // 3) 当前选中会话（面板永远显示当前会话的树，兜底必刷）。
          const parents = new Set();
          try {
            const snap = svc.list && svc.list.getSnapshot && svc.list.getSnapshot();
            const byId = snap && snap.byId;
            if (byId) for (const s of Object.values(byId)) {
              if (s.origin === 'subagent' && s.parentId) parents.add(s.parentId);
            }
            if (snap && snap.current && byId && !byId[snap.current]) parents.add(snap.current);
          } catch (e) { /* 快照不可用时跳过目录刷新 */ }
          if (Array.isArray(extraParents)) for (const pid of extraParents) {
            if (pid) parents.add(pid);
          }
          // 先等所有 refreshSubagents 完成（subagents.list RPC 更新 catalogs），
          // 再 refreshList（sessions.list RPC 重建快照，subagentsByParent 从
          // catalogs 派生）。若不加 await，两个异步 RPC 并发，refreshList 可能
          // 先返回——重建快照时 catalogs 还是旧数据，better-sidebar 面板的
          // subagentsByParent 不更新，界面陈留。await 保证「目录先刷新、
          // 列表再重建」的顺序。
          if (typeof svc.refreshSubagents === 'function') {
            await Promise.all([...parents].map((pid) => svc.refreshSubagents(pid)));
          }
          if (typeof svc.refreshList === 'function') await svc.refreshList();
        } catch (e) {
          console.error('[dsh-session-pruner] refresh failed', e);
        }
      };
      let refreshTimer = null;
      const schedule = () => {
        let secs = 30;
        try {
          const sv = ctx.settingsScope && ctx.settingsScope.bind({ namespace: NS });
          if (sv) secs = Number((sv.getSnapshot().value || {}).uiRefreshSeconds) || 30;
        } catch (e) { /* 面板不可用时用默认 */ }
        if (refreshTimer) window.clearInterval(refreshTimer);
        refreshTimer = window.setInterval(refresh, secs * 1000);
      };
      window.setTimeout(refresh, 5000);
      schedule();
      try {
        const sv = ctx.settingsScope && ctx.settingsScope.bind({ namespace: NS });
        if (sv && typeof sv.subscribe === 'function') sv.subscribe(schedule);
      } catch (e) { /* 无面板时保持默认 30s */ }

      // ===== Step 2：dirty-flag 变更驱动刷新（主路径） =====
      // host 每次归档写内存变更日志（单调 seq）；client 每 3s 打一个极轻的
      // HTTP 路由（agent-teams 生产同款 1s 轮询模式），只有「有归档变更」
      // 才发 refresh RPC——把 210s 盲轮询变成「变更才做重活」。上面的
      // schedule()/refresh 保留为兜底：路由不可用（host 未升级）时照旧刷新。
      let lastSeq = 0;
      const pollArchived = () => {
        try {
          fetch('/plugins/dsh-session-pruner/archived?since=' + lastSeq, { cache: 'no-store' })
            .then((res) => (res.ok ? res.json() : null))
            .then((data) => {
              if (!data || typeof data.seq !== 'number') return;
              // host 重启后 seq 归零（内存日志清空重数）：若服务端 seq 比本地还小，
              // 说明重启过，把 since 归零下一轮全量重拉，否则 dirty-flag 主路径会
              // 因「本地 since 永远大于新 seq」静默失效（只剩 30s 兜底刷新）。
              if (data.seq < lastSeq) {
                lastSeq = 0;
                return; // 本轮 since 用旧值已空，下一轮 since=0 全量补拉
              }
              lastSeq = data.seq;
              if (data.archived && data.archived.length > 0) {
                // archived 条目可能携带 parentSessionId：传给 refresh 刷对应目录
                // （覆盖 one-shot 归档后父会话已不在 byId 的场景）
                const affected = (data.archived || [])
                  .map((a) => a && a.parentSessionId)
                  .filter(Boolean);
                refresh(affected);
              }
            })
            .catch(() => { /* 路由不可用（host 旧版/晚绑定）→ 兜底轮询接管 */ });
        } catch (e) { /* fetch 不可用环境（旧浏览器）→ 兜底轮询接管 */ }
      };
      window.setTimeout(pollArchived, 1000);
      window.setInterval(pollArchived, 3000);
    }

    exports.apply = apply;
    exports.name = 'dsh-session-pruner';
    exports.inject = ['slots', 'settingsScope'];
    return module.exports;
  },
});
