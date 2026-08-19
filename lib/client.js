/* dsh-session-lifecycle client bundle — 设置面板卡片（手写，无构建链）。
 * 注册进「设置 → 插件配置」标签页，编辑扫描间隔/容量保底/cleanMain，
 * 保存即热加载（Host 侧 installSettingsSection 的 onChange 即时生效）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-session-lifecycle',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });
    const { createElement: h, useEffect, useRef, useState } = require('react');
    require('react/jsx-runtime');

    const NS = 'session-lifecycle';

    const CARD_TONE = {
      row: 'var(--dsw-alias-bg-layer-3, #1d2735)',
      border: 'var(--dsw-alias-border-l2, rgba(196, 211, 232, 0.16))',
      text: 'var(--dsw-alias-label-primary, #f2f6fc)',
      muted: 'var(--dsw-alias-label-secondary, #9daabd)',
      accent: 'var(--dsw-alias-brand-primary, #8ec5ff)',
    };

    // 设置面板卡片：三个字段 + 保存（保存 = 写 settings section → Host onChange 热加载）
    function LifecycleCard(props) {
      const scope = props.scope;
      const [snap, setSnap] = useState(() => scope.getSnapshot());
      useEffect(() => scope.subscribe(() => setSnap(scope.getSnapshot())), [scope]);

      const value = snap.value || {};
      // 草稿：从 snapshot 同步（仅在外部值变化时重置）
      const [draft, setDraft] = useState(null);
      const [saving, setSaving] = useState(false);
      const [msg, setMsg] = useState('');
      const [expanded, setExpanded] = useState(true);
      useEffect(() => {
        setDraft({
          intervalMinutes: String(value.intervalMinutes ?? 30),
          maxSessions: String(value.maxSessions ?? 400),
          cleanMain: !!value.cleanMain,
        });
      }, [snap.value, snap.revision]);

      const save = async () => {
        if (!draft) return;
        setSaving(true);
        setMsg('');
        try {
          const min = Number(draft.intervalMinutes);
          const max = Number(draft.maxSessions);
          if (!Number.isFinite(min) || min < 1 || min > 1440) {
            setMsg('间隔需为 1–1440 分钟');
            return;
          }
          if (!Number.isFinite(max) || max < 50) {
            setMsg('保底数需 ≥ 50');
            return;
          }
          await scope.set('intervalMinutes', min);
          await scope.set('maxSessions', max);
          await scope.set('cleanMain', !!draft.cleanMain);
          setMsg('✓ 已保存并热加载');
        } catch (e) {
          setMsg('保存失败: ' + (e && e.message ? e.message : String(e)));
        } finally {
          setSaving(false);
        }
      };

      const statusLabel =
        snap.status === 'loading' ? '加载中…'
        : snap.status === 'unavailable' ? '不可用（设置服务未挂载）'
        : snap.writable ? '编辑后保存即生效（热加载）'
        : '只读（memory 模式）';

      const row = (label, hint, control) =>
        h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', padding: '8px 12px', borderRadius: '8px', background: CARD_TONE.row } },
          h('div', { style: { minWidth: 0 } },
            h('div', { style: { color: CARD_TONE.text, fontSize: 13 } }, label),
            hint ? h('div', { style: { color: CARD_TONE.muted, fontSize: 12, marginTop: 2 } }, hint) : null),
          control);

      const numberInput = (field) =>
        h('input', {
          value: draft ? draft[field] : '',
          onChange: (e) => setDraft({ ...draft, [field]: e.target.value }),
          style: {
            width: 90, padding: '4px 8px', borderRadius: 6, fontSize: 13,
            border: '1px solid ' + CARD_TONE.border,
            background: 'var(--dsw-alias-bg-layer-1, #171f2b)',
            color: CARD_TONE.text, textAlign: 'right',
          },
        });

      const summary =
        '间隔 ' + (value.intervalMinutes ?? 30) + ' 分钟 · 保底 ' + (value.maxSessions ?? 400) +
        ' · ' + (value.cleanMain ? '含主会话' : '保留主会话');

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8, padding: '12px 0' } },
        h('button', {
          onClick: () => setExpanded(!expanded),
          style: {
            display: 'flex', alignItems: 'center', gap: 8, width: '100%',
            padding: '8px 12px', borderRadius: 8, cursor: 'pointer', textAlign: 'left',
            border: '1px solid ' + CARD_TONE.border, background: CARD_TONE.row,
          },
        },
          h('span', { style: { color: CARD_TONE.accent, fontSize: 13, fontWeight: 600, flexShrink: 0 } }, 'session-lifecycle'),
          h('span', { style: { color: CARD_TONE.muted, fontSize: 12, flex: 1 } }, summary),
          h('span', { style: { color: CARD_TONE.muted, fontSize: 11 } }, expanded ? '▾ 收起' : '▸ 展开')),
        expanded ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 4 } },
          row('扫描间隔（分钟）', 'one-shot 完成后最长存活时间', numberInput('intervalMinutes')),
        row('容量保底（会话数）', '超限按 one-shot → 可续 → 主会话 回收最旧', numberInput('maxSessions')),
        row('超限时清理主会话', '默认保留 main，仅超限且开启才回收',
          h('input', {
            type: 'checkbox',
            checked: draft ? draft.cleanMain : false,
            onChange: (e) => setDraft({ ...draft, cleanMain: e.target.checked }),
            style: { width: 16, height: 16 },
          })),
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, padding: '0 12px' } },
          h('button', {
            onClick: save,
            disabled: saving || snap.status !== 'ready' || !snap.writable || !draft,
            style: {
              padding: '6px 16px', borderRadius: 6, fontSize: 13, cursor: 'pointer',
              border: 'none', color: '#0b1220',
              background: CARD_TONE.accent, opacity: saving ? 0.6 : 1,
            },
          }, saving ? '保存中…' : '保存并应用'),
          h('span', { style: { color: CARD_TONE.muted, fontSize: 12 } }, statusLabel),
          msg ? h('span', { style: { color: msg.startsWith('✓') ? 'var(--dsw-alias-state-success-primary, #78dda0)' : 'var(--dsw-alias-state-error-primary, #ff8592)', fontSize: 12 } }, msg) : null),
        ) : null,
      );
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
    }

    exports.apply = apply;
    exports.name = 'session-lifecycle';
    exports.inject = ['slots', 'settingsScope'];
    return module.exports;
  },
});
