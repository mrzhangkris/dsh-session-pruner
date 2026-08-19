/* dsh-session-lifecycle client bundle — 设置面板卡片（手写，无构建链）。
 * 结构对齐官方 PluginCard：li 卡片默认折叠 → header(名称+描述+chevron)
 * → body(ValueField 字段 + footer: discard/save)。样式抄官方
 * fields.module.css / PluginCard.module.css 的 CSS 变量与尺寸。
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-lifecycle',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    const { createElement: h, useEffect, useState } = require('react');
    require('react/jsx-runtime');

    const NS = 'session-lifecycle';
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
      useEffect(() => {
        setDraft({
          intervalMinutes: String(value.intervalMinutes ?? 30),
          maxSessions: String(value.maxSessions ?? 400),
          cleanMain: !!value.cleanMain,
          uiRefreshSeconds: String(value.uiRefreshSeconds ?? 30),
        });
      }, [snap.value, snap.revision]);

      if (!draft) return null;
      const writable = !!snap.writable && snap.status === 'ready';
      const dirty =
        Number(draft.intervalMinutes) !== (value.intervalMinutes ?? 30) ||
        Number(draft.maxSessions) !== (value.maxSessions ?? 400) ||
        !!draft.cleanMain !== !!value.cleanMain ||
        Number(draft.uiRefreshSeconds) !== (value.uiRefreshSeconds ?? 30);
      const minOk = Number(draft.intervalMinutes) >= 1 && Number(draft.intervalMinutes) <= 1440;
      const maxOk = Number(draft.maxSessions) >= 50;
      const uiOk = Number(draft.uiRefreshSeconds) >= 5 && Number(draft.uiRefreshSeconds) <= 600;
      const invalid = !minOk || !maxOk || !uiOk;

      const save = async () => {
        if (invalid || !dirty) return;
        setSaving(true); setFailed(false);
        try {
          await scope.set('intervalMinutes', Number(draft.intervalMinutes));
          await scope.set('maxSessions', Number(draft.maxSessions));
          await scope.set('cleanMain', !!draft.cleanMain);
          await scope.set('uiRefreshSeconds', Number(draft.uiRefreshSeconds));
        } catch (e) {
          setFailed(true);
          console.error('[session-lifecycle] save failed', e);
        } finally {
          setSaving(false);
        }
      };
      const discard = () => {
        setDraft({
          intervalMinutes: String(value.intervalMinutes ?? 30),
          maxSessions: String(value.maxSessions ?? 400),
          cleanMain: !!value.cleanMain,
          uiRefreshSeconds: String(value.uiRefreshSeconds ?? 30),
        });
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
          invalid: f === 'intervalMinutes' ? !minOk : !maxOk,
          onEdit: (t) => setDraft({ ...draft, [f]: t }),
          onReset: () => setDraft({ ...draft, [f]: String(value[f] ?? (f === 'intervalMinutes' ? 30 : 400)) }),
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
          h('span', { style: { color: V.text1, fontSize: 15, fontWeight: 600, lineHeight: 1.4 } }, 'session-lifecycle'),
          h('span', { style: { color: V.text3, fontSize: 13, lineHeight: 1.5 } },
            '会话生命周期：间隔 ' + (value.intervalMinutes ?? 30) + ' 分钟 · 保底 ' + (value.maxSessions ?? 400) + ' · ' + (value.cleanMain ? '含主会话' : '保留主会话'))),
        dirty ? h('span', { style: { whiteSpace: 'nowrap', background: V.bgModule, color: V.text2, borderRadius: 999, flex: 'none', padding: '1px 8px', fontSize: 11, fontWeight: 500, lineHeight: '17px' } }, '未保存') : null,
        h('span', { style: { color: V.text3, flex: 'none', transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .16s' } }, '▾'));

      const body = h('div', { style: { borderTop: '1px solid ' + V.border, margin: '0 16px', paddingBottom: 8 } },
        !writable ? h('p', { style: { color: V.text3, margin: '12px 0 0', fontSize: 12, lineHeight: 1.5 } }, '只读（memory 模式）') : null,
        field('intervalMinutes', '扫描间隔（分钟）', 'one-shot 完成后最长存活时间，保存即热加载'),
        field('maxSessions', '容量保底（会话数）', '超限按 one-shot → 可续 → 主会话 回收最旧'),
        field('uiRefreshSeconds', '界面刷新间隔（秒）', 'GUI 会话列表自动刷新周期，默认 30'),
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
      // 定时调 sessions.refreshList()（session.list RPC 读磁盘目录，轻量）——
      // 被清理的会话在侧边栏自动消失，无需手动刷新页面。
      const refresh = () => {
        try {
          const svc = ctx.get && ctx.get('sessions');
          if (svc && typeof svc.refreshList === 'function') svc.refreshList();
        } catch (e) {
          console.error('[session-lifecycle] refreshList failed', e);
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
    }

    exports.apply = apply;
    exports.name = 'session-lifecycle';
    exports.inject = ['slots', 'settingsScope'];
    return module.exports;
  },
});
