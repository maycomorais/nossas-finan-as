/* ============================================================
   FINANÇAS FAMÍLIA — script.js v3.1
   Módulos: Config → ExchangeAPI → OfflineQueue → DB →
            Calc → UIList → UITotals → UIDashboard →
            UIDatalist → UIToast → UIConnStatus → UILoading →
            Modal → FormHandler → App
   ============================================================ */

'use strict';

// ============================================================
// CONFIG
// ============================================================
const Config = {
    SB_URL:        'https://alpyltplxrhrwxygkkar.supabase.co',
    SB_KEY:        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFscHlsdHBseHJocnd4eWdra2FyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI0Njg5NDUsImV4cCI6MjA4ODA0NDk0NX0.QjM7L6sxNB4-LN3_x-ijo3MoZrpgzgkO8E79UUD2vUk',
    EXCHANGE_URL:  'https://economia.awesomeapi.com.br/last/BRL-PYG',
    FALLBACK_RATE: 1420,
    OFFLINE_KEY:   'fm_offline_queue_v1',
    MONEYGRAM_SPREAD: 0.0618,   // 6,18% de custo aplicado sobre cotação base
    CHART_COLORS:  [
        '#ef4444','#f97316','#eab308','#22c55e','#3b82f6',
        '#8b5cf6','#ec4899','#14b8a6','#f43f5e','#6366f1',
        '#84cc16','#0ea5e9','#a855f7','#fb923c','#34d399',
    ],
    INTL_METHODS: ['Wise', 'Moneygram', 'Transferência'],
};

const _sb = supabase.createClient(Config.SB_URL, Config.SB_KEY);

// ============================================================
// FORMATTERS
// ============================================================
const fmt = {
    brl:   v => `R$ ${Math.abs(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
    pyg:   v => `₲ ${Math.abs(v).toLocaleString('es-PY', { maximumFractionDigits: 0 })}`,
    money: (v, moeda) => moeda === 'BRL' ? fmt.brl(v) : fmt.pyg(v),
    date:  d => d ? d.split('-').reverse().join('/') : '—',
    pct:   (v, t) => t > 0 ? ((v / t) * 100).toFixed(1) + '%' : '—',
};

// ============================================================
// CONSTANTS
// ============================================================
const TIPOS_GASTO = ['SAIDA', 'GASTO_FIXO', 'GASTO_VARIAVEL', 'DIVIDA'];

// ============================================================
// STATE
// ============================================================
const State = {
    transactions:  [],
    exchangeRate:  Config.FALLBACK_RATE,
    currentFilter: 'TUDO',
    dashMoeda:     'BRL',
    dashType:      'SAIDA',
    dashOrigin:    'TUDO',
    charts:        {},
    isOnline:      navigator.onLine,
};

// ============================================================
// EXCHANGE RATE API
// ============================================================
const ExchangeAPI = {
    async fetch() {
        try {
            const res  = await fetch(Config.EXCHANGE_URL);
            const data = await res.json();
            const rate = parseFloat(data?.BRLPYG?.bid);
            if (rate && rate > 0) {
                State.exchangeRate = rate;
                this._updateBadge();
                return;
            }
        } catch (_) {}

        try {
            const res  = await fetch('https://open.er-api.com/v6/latest/BRL');
            const data = await res.json();
            if (data?.rates?.PYG) State.exchangeRate = data.rates.PYG * 0.98;
        } catch (_) {
            console.warn('ExchangeAPI: usando fallback', Config.FALLBACK_RATE);
        }
        this._updateBadge();
    },

    _updateBadge() {
        const el = document.getElementById('cambio-valor');
        if (el) el.textContent = `R$1 = ₲ ${State.exchangeRate.toFixed(0)}`;
    },
};

// ============================================================
// OFFLINE QUEUE
// ============================================================
const OfflineQueue = {
    _key: Config.OFFLINE_KEY,

    load() {
        try { return JSON.parse(localStorage.getItem(this._key) || '[]'); }
        catch (_) { return []; }
    },

    save(queue) {
        localStorage.setItem(this._key, JSON.stringify(queue));
        this._updateBanner();
    },

    enqueue(action, payloads) {
        const q = this.load();
        q.push({ _offlineId: crypto.randomUUID(), _queuedAt: new Date().toISOString(), action, payloads });
        this.save(q);
        UIToast.show('📶 Sem conexão — salvo localmente', 'warning');
    },

    count() { return this.load().length; },

    _updateBanner() {
        const n      = this.count();
        const banner = document.getElementById('offline-banner');
        const text   = document.getElementById('offline-banner-text');
        if (!banner) return;
        if (n > 0) {
            if (text) text.textContent = `${n} operação(ões) aguardando sincronização — toque para sincronizar`;
            banner.style.display = 'flex';
        } else {
            banner.style.display = 'none';
        }
    },

    async drain() {
        const queue = this.load();
        if (!queue.length) return;
        UIToast.show(`📶 Sincronizando ${queue.length} item(s)…`, 'info');
        const failed = [];

        for (const item of queue) {
            let err = null;
            try {
                if (item.action === 'insert' || item.action === 'insertMany') {
                    ({ error: err } = await _sb.from('transacoes').insert(item.payloads));
                } else if (item.action === 'update') {
                    ({ error: err } = await _sb.from('transacoes').update(item.payloads.payload).eq('id', item.payloads.id));
                } else if (item.action === 'delete') {
                    ({ error: err } = await _sb.from('transacoes').delete().eq('id', item.payloads.id));
                }
            } catch (e) { err = e; }
            if (err) { console.error('Queue drain error:', item._offlineId, err); failed.push(item); }
        }

        this.save(failed);
        if (!failed.length) {
            UIToast.show('✅ Sincronização completa!', 'success');
            app.fetchData();
        } else {
            UIToast.show(`⚠️ ${failed.length} item(s) não sincronizados`, 'danger');
        }
    },

    init() {
        this._updateBanner();
        window.addEventListener('online', async () => {
            State.isOnline = true;
            UIConnStatus.update(true);
            await this.drain();
        });
        window.addEventListener('offline', () => {
            State.isOnline = false;
            UIConnStatus.update(false);
        });
    },
};

// ============================================================
// DB — Supabase + offline fallback
// ============================================================
const DB = {
    async fetchMonth(year, month) {
        if (!State.isOnline) { UIToast.show('Offline — sem novos dados', 'warning'); return []; }
        const lastDay = new Date(Number(year), Number(month), 0).getDate();
        const { data, error } = await _sb
            .from('transacoes').select('*')
            .gte('data', `${year}-${month}-01`)
            .lte('data', `${year}-${month}-${String(lastDay).padStart(2, '0')}`)
            .order('data', { ascending: false });
        if (error) { console.error('DB.fetchMonth:', error); UIToast.show('Erro ao buscar: ' + error.message, 'danger'); return []; }
        return data || [];
    },

    async insert(payload) {
        if (!State.isOnline) { OfflineQueue.enqueue('insert', [payload]); return null; }
        const { error } = await _sb.from('transacoes').insert([payload]);
        return error;
    },

    async insertMany(payloads) {
        if (!State.isOnline) { OfflineQueue.enqueue('insertMany', payloads); return null; }
        const { error } = await _sb.from('transacoes').insert(payloads);
        return error;
    },

    async update(id, payload) {
        if (!State.isOnline) { OfflineQueue.enqueue('update', { id, payload }); return null; }
        const { error } = await _sb.from('transacoes').update(payload).eq('id', id);
        return error;
    },

    async delete(id) {
        if (!State.isOnline) { OfflineQueue.enqueue('delete', { id }); return null; }
        const { error } = await _sb.from('transacoes').delete().eq('id', id);
        return error;
    },

    async uploadFile(file) {
        if (!State.isOnline) { UIToast.show('Offline — foto não enviada', 'warning'); return null; }
        const name = `${Date.now()}-${Math.random().toString(36).slice(2)}.${file.name.split('.').pop()}`;
        const { data } = await _sb.storage.from('comprovantes').upload(name, file);
        if (!data) return null;
        return _sb.storage.from('comprovantes').getPublicUrl(name).data?.publicUrl || null;
    },
};

// ============================================================
// CALC
// ============================================================
const Calc = {
    txRate: t => t.taxa_cambio_dia || State.exchangeRate,

    balance(txs, moeda, { onlyAvailable = true } = {}) {
        return txs.filter(t => {
            if (t.tipo === 'TRANSFERENCIA')                  return false;
            if (t.tipo === 'DIVIDA' && t.status !== 'PAGA') return false;
            if (onlyAvailable && t.is_reserva)              return false;
            if (t.moeda !== moeda)                          return false;
            return true;
        }).reduce((acc, t) => acc + (t.tipo === 'ENTRADA' ? t.valor : -t.valor), 0);
    },

    balanceReserva: (txs, moeda) =>
        txs.filter(t => t.tipo !== 'TRANSFERENCIA' && t.moeda === moeda && t.is_reserva)
           .reduce((acc, t) => acc + (t.tipo === 'ENTRADA' ? t.valor : -t.valor), 0),

    pl(txs, { tipo = null, moeda = null, origin = 'TUDO', convertAll = false } = {}) {
        return txs.filter(t => {
            if (t.tipo === 'TRANSFERENCIA')                       return false;
            if (tipo   && t.tipo !== tipo)                        return false;
            if (moeda  && t.moeda !== moeda)                      return false;
            if (origin !== 'TUDO' && t.origem_destino !== origin) return false;
            return true;
        }).reduce((acc, t) => {
            const v = convertAll && t.moeda === 'BRL' ? t.valor * this.txRate(t) : t.valor;
            return acc + (t.tipo === 'ENTRADA' ? v : -v);
        }, 0);
    },

    conciliacaoStats(txs) {
        const r = txs.filter(t => t.tipo !== 'TRANSFERENCIA');
        return { total: r.length, concil: r.filter(t => t.conciliado).length, pending: r.filter(t => !t.conciliado).length };
    },
};

// ============================================================
// UI — Toast
// ============================================================
const UIToast = {
    _el: null,
    init() { this._el = document.getElementById('toast-container'); },
    show(msg, type = 'info', ms = 3500) {
        if (!this._el) return;
        const el = document.createElement('div');
        el.className   = `toast toast--${type}`;
        el.textContent = msg;
        this._el.appendChild(el);
        requestAnimationFrame(() => el.classList.add('toast--visible'));
        setTimeout(() => { el.classList.remove('toast--visible'); setTimeout(() => el.remove(), 400); }, ms);
    },
};

// ============================================================
// UI — Connection dot
// ============================================================
const UIConnStatus = {
    update(online) {
        const el = document.getElementById('conn-dot');
        if (el) { el.className = `conn-dot conn-dot--${online ? 'online' : 'offline'}`; el.title = online ? 'Online' : 'Offline'; }
    },
};

// ============================================================
// UI — Loading skeleton
// ============================================================
const UILoading = {
    show() {
        const el = document.getElementById('transaction-list');
        if (!el) return;
        el.innerHTML = Array.from({ length: 3 }, () => `
            <div class="skeleton-card">
                <div class="skeleton-header">
                    <div class="skel skel--title"></div>
                    <div class="skel skel--amount"></div>
                </div>
                <div class="skeleton-rows">
                    ${Array.from({ length: 2 }, () => `
                        <div class="skeleton-row">
                            <div class="skel skel--icon"></div>
                            <div class="skel skel--line"></div>
                            <div class="skel skel--val"></div>
                        </div>`).join('')}
                </div>
            </div>`).join('');
    },
};

// ============================================================
// UI — List
// ============================================================
const UIList = {
    render(data) {
        const list = document.getElementById('transaction-list');

        if (!data.length) {
            list.innerHTML = `
                <div class="empty-state">
                    <span class="material-symbols-rounded">inbox</span>
                    <p>Nenhuma movimentação no período</p>
                </div>`;
            return;
        }

        const stats      = Calc.conciliacaoStats(data);
        const concBanner = stats.pending > 0
            ? `<div class="concil-banner">
                   <span class="material-symbols-rounded">fact_check</span>
                   <span><strong>${stats.concil}</strong> de <strong>${stats.total}</strong> conciliados
                         — <strong>${stats.pending}</strong> pendente(s)</span>
               </div>` : '';

        const groups = {};
        data.forEach(t => {
            const key = t.origem_destino || '(sem origem)';
            if (!groups[key]) groups[key] = { items: [], brl: 0, pyg: 0 };
            groups[key].items.push(t);
            this._accumulate(groups[key], t);
        });

        list.innerHTML = concBanner + Object.keys(groups).map((k, i) => this._groupCard(k, groups[k], i)).join('');
    },

    _accumulate(g, t) {
        if (t.tipo === 'TRANSFERENCIA') return;
        const sign = State.currentFilter === 'TUDO'
            ? (t.tipo === 'ENTRADA' ? 1 : t.tipo === 'SAIDA' ? -1 : 0) : 1;
        if (t.moeda === 'BRL') g.brl += t.valor * sign;
        if (t.moeda === 'PYG') g.pyg += t.valor * sign;
    },

    _groupCard(origem, g, idx) {
        const isAll  = State.currentFilter === 'TUDO';
        const brlStr = g.brl !== 0 ? `<span class="${g.brl > 0 && isAll ? 'text-success' : g.brl < 0 ? 'text-danger' : ''}">${fmt.brl(g.brl)}</span>` : '';
        const pygStr = g.pyg !== 0 ? `<span class="${g.pyg > 0 && isAll ? 'text-success' : g.pyg < 0 ? 'text-danger' : ''}">${fmt.pyg(g.pyg)}</span>` : '';

        return `
        <div class="group-card">
            <div class="group-header" onclick="app.toggleGroup(${idx})">
                <div class="group-title">
                    <span class="material-symbols-rounded" id="icon-group-${idx}"
                          style="color:#94a3b8;transition:transform 0.25s;font-size:20px;">expand_more</span>
                    ${this._esc(origem)}
                </div>
                <div class="group-total">${[brlStr, pygStr].filter(Boolean).join('<br>') || '—'}</div>
            </div>
            <div class="group-body" id="body-group-${idx}">
                ${g.items.map(t => this._txItem(t)).join('')}
            </div>
        </div>`;
    },

    _txItem(t) {
        const isTr = t.tipo === 'TRANSFERENCIA', isIn = t.tipo === 'ENTRADA',
              isOut = t.tipo === 'SAIDA',         isDt = t.tipo === 'DIVIDA';
        const iconCls = isTr ? 'transfer' : isIn ? 'in' : isOut ? 'out' : 'debt';
        const iconSym = isTr ? '⇄' : isIn ? '↑' : isOut ? '↓' : '⏳';
        const valCls  = isTr ? 'transfer' : isIn ? 'plus' : 'minus';
        const sub     = [t.local_dinheiro, t.metodo, isTr && t.wallet_dest ? `→ ${t.wallet_dest}` : null, t.categoria].filter(Boolean).join(' · ');

        const badges = [
            t.total_parcelas > 1          ? `<span class="parcela-badge">${t.parcela_atual}/${t.total_parcelas}</span>` : '',
            (isDt || t.status === 'PENDENTE') ? `<span class="status-badge status-${t.status || 'PENDENTE'}">${t.status || 'PENDENTE'}</span>` : '',
            t.is_reserva                  ? `<span class="status-badge status-reserva">🐷 Caixinha</span>` : '',
            t.conciliado                  ? `<span class="status-badge status-conciliado">✓ Conc.</span>` : '',
            t.taxa_cambio_dia             ? `<span class="taxa-tag" title="Taxa histórica">₲${parseFloat(t.taxa_cambio_dia).toFixed(0)}</span>` : '',
        ].join('');

        const photo = t.comprovante_url
            ? `<span class="material-symbols-rounded has-photo" onclick="window.open('${t.comprovante_url}')" title="Ver comprovante">image</span>` : '';

        return `
        <div class="tx-item ${t.conciliado ? 'tx-item--conciliado' : ''}">
            <div class="tx-icon tx-icon--${iconCls}">${iconSym}</div>
            <div class="card-info">
                <div class="tx-title">${this._esc(t.origem_destino || '—')} ${photo}</div>
                <div class="tx-sub">${this._esc(sub)}</div>
                ${t.observacoes ? `<div class="tx-sub tx-obs">"${this._esc(t.observacoes)}"</div>` : ''}
                <div class="tx-badges">${badges}</div>
            </div>
            <div class="card-value">
                <div class="val ${valCls}">${fmt.money(t.valor, t.moeda)}</div>
                <div class="tx-date">${fmt.date(t.data)}</div>
            </div>
            <button class="btn-edit-icon" onclick="app.editTx('${t.id}')" title="Editar">
                <span class="material-symbols-rounded">edit</span>
            </button>
        </div>`;
    },

    _esc: s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
};

// ============================================================
// UI — Totals
// ============================================================
const UITotals = {
    update(txs) {
        const taxa   = State.exchangeRate;
        const brlD   = Calc.balance(txs, 'BRL', { onlyAvailable: true });
        const pygD   = Calc.balance(txs, 'PYG', { onlyAvailable: true });
        const brlR   = Calc.balanceReserva(txs, 'BRL');
        const pygR   = Calc.balanceReserva(txs, 'PYG');
        const total  = pygD + brlD * taxa;
        const patrim = total + pygR + brlR * taxa;

        // Signed formatters: prefix '−' when negative (fmt.brl/pyg use Math.abs internally)
        const signedBrl = v => (v < 0 ? '−' : '') + fmt.brl(v);
        const signedPyg = v => (v < 0 ? '−' : '') + fmt.pyg(v);

        this._anim('balance-brl',   signedBrl(brlD));
        this._anim('balance-pyg',   signedPyg(pygD));
        this._anim('balance-total', signedPyg(total));

        // Color cards red when negative so the sign is visually obvious
        const elBrl   = document.getElementById('balance-brl');
        const elPyg   = document.getElementById('balance-pyg');
        const elTotal = document.getElementById('balance-total');
        if (elBrl)   elBrl.style.color   = brlD  < 0 ? '#fca5a5' : '';
        if (elPyg)   elPyg.style.color   = pygD  < 0 ? '#fca5a5' : '';
        if (elTotal) elTotal.style.color = total < 0 ? '#fca5a5' : '';

        document.getElementById('balance-brl-reserva').textContent = brlR !== 0 ? `+ ${fmt.brl(brlR)} caixinha` : '';
        const mgRate = taxa * (1 - Config.MONEYGRAM_SPREAD);
        const mgEl   = document.getElementById('balance-brl-mg');
        if (mgEl) mgEl.textContent = brlD !== 0 ? `≈ ${signedPyg(brlD * mgRate)} (MG)` : '';
        document.getElementById('balance-pyg-reserva').textContent = pygR !== 0 ? `+ ${fmt.pyg(pygR)} caixinha` : '';
        document.getElementById('balance-patrimonio').textContent  = `Patrimônio: ${signedPyg(patrim)}`;
    },

    _anim(id, value) {
        const el = document.getElementById(id);
        if (!el) return;
        el.style.cssText = 'opacity:.4;transform:translateY(4px);transition:opacity .2s,transform .2s';
        requestAnimationFrame(() => { el.textContent = value; el.style.cssText = 'opacity:1;transform:translateY(0);transition:opacity .2s,transform .2s'; });
    },
};

// ============================================================
// UI — Dashboard
// ============================================================
const UIDashboard = {
    update(txs) {
        const origin   = State.dashOrigin;
        const filtered = origin === 'TUDO' ? txs : txs.filter(t => t.origem_destino === origin);

        const ent = Calc.pl(filtered, { tipo: 'ENTRADA', convertAll: true });
        const sai = Math.abs(Calc.pl(filtered, { tipo: 'SAIDA',   convertAll: true }));
        const res = ent - sai;

        document.getElementById('dash-total-entradas').textContent = fmt.pyg(ent);
        document.getElementById('dash-total-saidas').textContent   = fmt.pyg(sai);
        const resEl = document.getElementById('dash-resultado');
        resEl.textContent = fmt.pyg(Math.abs(res));
        resEl.style.color = res >= 0 ? 'var(--success)' : 'var(--danger)';

        this._biggestExpense(filtered);
        this._concilStats(filtered);
        this._updateOriginSelect(txs);

        ['brl','pyg','mix'].forEach(m =>
            document.getElementById(`dash-btn-${m}`)?.classList.toggle('active', State.dashMoeda === m.toUpperCase()));
        ['tudo','entrada','saida','divida'].forEach(t =>
            document.getElementById(`dash-btn-${t}`)?.classList.toggle('active', State.dashType === t.toUpperCase()));

        this._renderChart(filtered);
    },

    _biggestExpense(txs) {
        const map = {};
        txs.filter(t => t.tipo === 'SAIDA').forEach(t => {
            const k = t.categoria || t.origem_destino || 'Outros';
            map[k]  = (map[k] || 0) + (t.moeda === 'BRL' ? t.valor * Calc.txRate(t) : t.valor);
        });
        const entries = Object.entries(map);
        if (!entries.length) { ['be-name','be-val','be-pct'].forEach(id => document.getElementById(id).textContent = '—'); return; }
        const total       = entries.reduce((a, [, v]) => a + v, 0);
        const [name, val] = entries.sort((a, b) => b[1] - a[1])[0];
        document.getElementById('be-name').textContent = name;
        document.getElementById('be-val').textContent  = fmt.pyg(val);
        document.getElementById('be-pct').textContent  = fmt.pct(val, total);
    },

    _concilStats(txs) {
        const el = document.getElementById('dash-concil-stats');
        if (!el) return;
        const s = Calc.conciliacaoStats(txs);
        if (!s.total) { el.style.display = 'none'; return; }
        const pct = Math.round((s.concil / s.total) * 100);
        el.style.display = 'flex';
        el.innerHTML = `
            <div class="concil-stat-bar"><div class="concil-fill" style="width:${pct}%"></div></div>
            <span class="concil-stat-text">
                <strong>${s.concil}/${s.total}</strong> conciliados (${pct}%)
                ${s.pending > 0 ? `— <span style="color:var(--warning)">${s.pending} pendente(s)</span>` : ''}
            </span>`;
    },

    _updateOriginSelect(txs) {
        const sel = document.getElementById('dash-filter-origin');
        const ori = [...new Set(txs.map(t => t.origem_destino).filter(Boolean))].sort();
        sel.innerHTML = `<option value="TUDO">Todas</option>` +
            ori.map(o => `<option value="${o}" ${o === State.dashOrigin ? 'selected' : ''}>${o}</option>`).join('');
    },

    _renderChart(txs) {
        const moeda = State.dashMoeda, tipo = State.dashType, colors = Config.CHART_COLORS;
        let labels = [], chartData = [], title = '';

        if (tipo === 'TUDO') {
            labels    = ['Entradas (₲)', 'Despesas (₲)'];
            chartData = [Calc.pl(txs, { tipo: 'ENTRADA', convertAll: true }), Calc.pl(txs, { tipo: 'SAIDA', convertAll: true })];
            title     = 'Visão Global (Guaranis)';
        } else {
            const base = txs.filter(t => t.tipo !== 'TRANSFERENCIA' && t.tipo === tipo && (moeda === 'MIX' || t.moeda === moeda));
            const gFn  = tipo === 'SAIDA' ? t => t.categoria || t.origem_destino || 'Outros' : t => t.origem_destino || 'Outros';
            const map  = {};
            base.forEach(t => { const k = gFn(t); map[k] = (map[k] || 0) + (moeda === 'MIX' && t.moeda === 'BRL' ? t.valor * Calc.txRate(t) : t.valor); });
            labels    = Object.keys(map);
            chartData = Object.values(map);
            const tL  = tipo === 'ENTRADA' ? 'Receitas' : tipo === 'SAIDA' ? 'Despesas' : 'Dívidas';
            const mL  = moeda === 'BRL' ? 'R$' : moeda === 'PYG' ? '₲' : '₲ (tudo)';
            title     = `${tL} por ${tipo === 'SAIDA' ? 'Categoria' : 'Origem'} (${mL})`;
        }

        document.getElementById('chartOriginsTitle').textContent = title;
        if (State.charts.expenses) State.charts.expenses.destroy();

        State.charts.expenses = new Chart(document.getElementById('chartExpenses').getContext('2d'), {
            type: 'doughnut',
            data: { labels, datasets: [{ data: chartData, backgroundColor: colors, borderWidth: 3, borderColor: '#fff', hoverOffset: 6 }] },
            options: {
                responsive: true, cutout: '60%',
                plugins: {
                    legend: { display: false },
                    tooltip: { callbacks: { label: ctx => ` ${ctx.label}: ${(moeda === 'MIX' || tipo === 'TUDO') ? fmt.pyg(ctx.parsed) : fmt.money(ctx.parsed, moeda)}` } },
                },
            },
        });

        const total    = chartData.reduce((a, b) => a + b, 0);
        const isMix    = moeda === 'MIX' || tipo === 'TUDO';
        const legendEl = document.getElementById('chart-legend');

        if (!chartData.length) { legendEl.innerHTML = `<div style="text-align:center;color:#94a3b8;padding:10px;">Sem dados</div>`; return; }

        legendEl.innerHTML = labels
            .map((l, i) => ({ l, v: chartData[i], c: colors[i % colors.length] }))
            .sort((a, b) => b.v - a.v)
            .map(({ l, v, c }) => `
            <div class="legend-item">
                <div class="legend-left"><div class="legend-color" style="background:${c}"></div><span>${l}</span></div>
                <div style="text-align:right;">
                    <div class="legend-val">${isMix ? fmt.pyg(v) : fmt.money(v, moeda)}</div>
                    <div style="font-size:0.7rem;color:#94a3b8;">${fmt.pct(v, total)}</div>
                </div>
            </div>`).join('');
    },
};

// ============================================================
// UI — Datalists
// ============================================================
const UIDatalist = {
    update(txs) {
        const fill = (id, items) => { const el = document.getElementById(id); if (el) el.innerHTML = items.map(v => `<option value="${v}">`).join(''); };
        fill('list-wallets',      [...new Set(txs.map(t => t.local_dinheiro).filter(Boolean))]);
        fill('list-wallets-dest', [...new Set(txs.map(t => t.local_dinheiro).filter(Boolean))]);
    },
};

// ============================================================
// MODAL
// ============================================================
const Modal = {
    open(defaultType = 'SAIDA') {
        document.getElementById('finance-form').reset();
        document.getElementById('tx-id').value               = '';
        document.getElementById('tx-transfer-pair-id').value = '';
        document.getElementById('type').value                = defaultType;
        document.getElementById('tx-date').value             = new Date().toISOString().split('T')[0];
        document.getElementById('parcela-atual').value       = '1';
        document.getElementById('total-parcelas').value      = '1';
        document.getElementById('btn-delete').classList.add('hidden');
        document.getElementById('modal-title').textContent   = 'Novo Registro';
        this.onTypeChange();
        this._show();
    },

    close() {
        document.getElementById('modal-content').classList.remove('active');
        setTimeout(() => document.getElementById('modal').classList.add('hidden'), 320);
    },

    _show() {
        document.getElementById('modal').classList.remove('hidden');
        setTimeout(() => document.getElementById('modal-content').classList.add('active'), 30);
    },

    _sf(id, v) { const el = document.getElementById(id); if (el) el.style.display = v ? '' : 'none'; },

    onTypeChange() {
        const t = document.getElementById('type').value;
        const isTr = t === 'TRANSFERENCIA', isDt = t === 'DIVIDA',
              isIn = t === 'ENTRADA',        isOut = t === 'SAIDA';

        this._sf('field-status',     isDt);
        this._sf('transfer-fields',  isTr);
        this._sf('field-origem',     isIn || isDt || isTr);
        this._sf('field-categoria',  isOut);
        this._sf('field-tipo-divida', isDt);
        this._sf('field-parcelas',   isOut || isDt);
        this._sf('field-reserva',    isIn);

        if (!isDt) document.getElementById('status').value = 'CONCLUIDO';
        if (!isIn) document.getElementById('is-reserva').checked = false;

        this.onMethodChange();
    },

    onCurrencyChange() {
        this.onMethodChange();
        this._updateRatePreview();
    },

    onMethodChange() {
        const method = document.getElementById('method').value;
        const tipo   = document.getElementById('type').value;
        const isWise = method === 'Wise';
        const isMG   = method === 'Moneygram';
        const showRemessa = (isWise || isMG) && (tipo === 'TRANSFERENCIA' || tipo === 'SAIDA');

        this._sf('remessa-block', showRemessa);
        this._sf('btn-fetch-wise', isWise && showRemessa);

        if (showRemessa) {
            const lbl = document.getElementById('remessa-label');
            if (lbl) lbl.textContent = isWise ? '🏦 Wise — cotação automática' : '💸 Moneygram — spread 4,2%';
            if (isMG) this._calcMoneygram();
        }
    },

    onOrigemChange() {
        const sel   = document.getElementById('origem-select');
        const outro = document.getElementById('origem-outro');
        if (!sel || !outro) return;
        outro.style.display = sel.value === 'Outro' ? '' : 'none';
        if (sel.value !== 'Outro') outro.value = '';
    },

    onCategoriaChange() {
        const sel   = document.getElementById('categoria');
        const outro = document.getElementById('categoria-outro');
        if (!sel || !outro) return;
        outro.style.display = sel.value === 'Outro' ? '' : 'none';
        if (sel.value !== 'Outro') outro.value = '';
    },

    _calcMoneygram() {
        const v    = parseFloat(document.getElementById('amount').value) || 0;
        const rate = State.exchangeRate;
        if (v <= 0 || !rate) return;
        const spread    = Config.MONEYGRAM_SPREAD;
        const resultado = Math.round(v * rate * (1 - spread));
        const taxa      = v * rate * spread;
        const vcEl      = document.getElementById('valor-convertido');
        const trEl      = document.getElementById('taxa-real');
        if (vcEl) vcEl.value = resultado;
        if (trEl) trEl.value = taxa.toFixed(2);
        this._updateRatePreview();
    },

    async fetchWiseQuote() {
        const v = parseFloat(document.getElementById('amount').value) || 0;
        if (v <= 0) { UIToast.show('Informe o valor antes de buscar cotação Wise.', 'warning'); return; }

        const btn = document.getElementById('btn-fetch-wise');
        if (btn) { btn.disabled = true; btn.textContent = '⏳ Buscando…'; }

        try {
            const res = await fetch(`${Config.SB_URL}/functions/v1/get-wise-quote`, {
                method:  'POST',
                headers: {
                    'Content-Type':  'application/json',
                    'Authorization': `Bearer ${Config.SB_KEY}`,
                },
                body: JSON.stringify({ sourceAmount: v, sourceCurrency: 'BRL', targetCurrency: 'PYG' }),
            });

            const data = await res.json();
            if (data.error) throw new Error(data.error);

            const vcEl = document.getElementById('valor-convertido');
            const trEl = document.getElementById('taxa-real');
            if (vcEl) vcEl.value = Math.round(data.targetAmount);
            if (trEl) trEl.value = (data.fee || 0).toFixed(2);
            this._updateRatePreview();
            UIToast.show(`✅ Wise: ₲ ${Math.round(data.targetAmount).toLocaleString('es-PY')} (taxa: R$ ${(data.fee || 0).toFixed(2)})`, 'success', 5000);
        } catch (err) {
            UIToast.show('Erro Wise: ' + err.message, 'danger', 6000);
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = '🔄 Atualizar'; }
        }
    },

    onParcelasChange() {
        const n = parseInt(document.getElementById('total-parcelas').value) || 1;
        const v = parseFloat(document.getElementById('amount').value) || 0;
        const d = document.getElementById('tx-date').value;
        const pre = document.getElementById('parcelas-preview');
        if (n <= 1) { pre.style.display = 'none'; return; }
        const [y, m, dd] = d ? d.split('-').map(Number) : [0, 0, 0];
        let html = `<strong>${n}x de ${v > 0 ? fmt.brl(v) : '—'}</strong><br>`;
        for (let i = 0; i < Math.min(n, 5); i++) {
            const mi = (m - 1 + i) % 12, yi = Math.floor((m - 1 + i) / 12);
            html += `• ${i + 1}ª: ${String(dd).padStart(2,'0')}/${String(mi + 1).padStart(2,'0')}/${y + yi}<br>`;
        }
        if (n > 5) html += `… até a ${n}ª parcela`;
        pre.style.display = 'block';
        pre.innerHTML     = html;
    },

    _updateRatePreview() {
        const vc = parseFloat(document.getElementById('valor-convertido').value);
        const v  = parseFloat(document.getElementById('amount').value);
        const el = document.getElementById('rate-preview');
        if (el && vc > 0 && v > 0) {
            el.style.display = 'block';
            el.textContent   = `Cotação efetiva: R$ 1 = ₲ ${(vc / v).toFixed(0)} (API: ₲ ${State.exchangeRate.toFixed(0)})`;
        } else if (el) {
            el.style.display = 'none';
        }
    },

    populate(t) {
        const sv = (id, v) => { const el = document.getElementById(id); if (el) el.value = v ?? ''; };
        sv('tx-id', t.id); sv('type', t.tipo); sv('currency', t.moeda); sv('amount', t.valor);
        sv('tx-date', t.data); sv('wallet', t.local_dinheiro || '');
        sv('method', t.metodo || 'Efectivo'); sv('notes', t.observacoes || ''); sv('status', t.status || 'CONCLUIDO');
        sv('parcela-atual', t.parcela_atual || 1); sv('total-parcelas', t.total_parcelas || 1);
        sv('wallet-dest', t.wallet_dest || ''); sv('currency-dest', t.moeda_dest || 'PYG');
        sv('taxa-real', t.taxa_real || ''); sv('valor-convertido', t.valor_convertido || '');
        sv('tx-transfer-pair-id', t.transferencia_id || '');

        // Restore Origem dropdown + "Outro" fallback
        const origemSel = document.getElementById('origem-select');
        const origemOutro = document.getElementById('origem-outro');
        if (origemSel) {
            const savedSel = t.origem_select || '';
            const opts = [...origemSel.options].map(o => o.value);
            if (savedSel && opts.includes(savedSel)) {
                origemSel.value = savedSel;
                if (savedSel === 'Outro' && origemOutro) {
                    origemOutro.style.display = '';
                    origemOutro.value = t.origem_destino || '';
                }
            } else if (t.origem_destino) {
                // Legacy: no dropdown record saved — put value as Outro
                origemSel.value = 'Outro';
                if (origemOutro) { origemOutro.style.display = ''; origemOutro.value = t.origem_destino; }
            }
        }

        // Restore Categoria dropdown + "Outro" fallback
        const catSel = document.getElementById('categoria');
        const catOutro = document.getElementById('categoria-outro');
        if (catSel) {
            const savedCat = t.categoria_select || t.categoria || '';
            const catOpts  = [...catSel.options].map(o => o.value);
            if (savedCat && catOpts.includes(savedCat)) {
                catSel.value = savedCat;
                if (savedCat === 'Outro' && catOutro) {
                    catOutro.style.display = '';
                    catOutro.value = t.categoria || '';
                }
            } else if (t.categoria) {
                catSel.value = 'Outro';
                if (catOutro) { catOutro.style.display = ''; catOutro.value = t.categoria; }
            }
        }

        // Tipo dívida
        sv('tipo-divida', t.tipo_divida || 'FIXA_MENSAL');

        document.getElementById('is-reserva').checked = !!t.is_reserva;
        document.getElementById('conciliado').checked  = !!t.conciliado;
        this.onTypeChange();
        document.getElementById('btn-delete').classList.remove('hidden');
        document.getElementById('modal-title').textContent = 'Editar Registro';
        this._show();
    },
};

// ============================================================
// FORM HANDLER
// ============================================================
const FormHandler = {
    setup() {
        document.getElementById('finance-form').onsubmit = async e => {
            e.preventDefault();
            const btn     = e.target.querySelector('.btn-submit');
            btn.disabled  = true;
            btn.innerHTML = '<span class="material-symbols-rounded spin">progress_activity</span> Salvando…';
            await this._save();
            btn.disabled  = false;
            btn.innerHTML = '<span class="material-symbols-rounded">save</span> Salvar';
        };
        document.getElementById('valor-convertido')?.addEventListener('input', () => Modal._updateRatePreview());
        document.getElementById('amount')?.addEventListener('input', () => {
            Modal.onParcelasChange();
            Modal._updateRatePreview();
            const method = document.getElementById('method')?.value;
            if (method === 'Moneygram') Modal._calcMoneygram();
        });
    },

    async _save() {
        const txId = document.getElementById('tx-id').value;
        const tipo = document.getElementById('type').value;
        const file = document.getElementById('file-input').files[0];
        const url  = file ? await DB.uploadFile(file) : null;
        const base = this._payload();
        if (url) base.comprovante_url = url;

        const err = txId                    ? await DB.update(txId, base)
                  : tipo === 'TRANSFERENCIA' ? await this._saveTransfer(base)
                  : await this._saveInstallments(base);

        if (err) { UIToast.show('Erro: ' + err.message, 'danger', 5000); return; }
        if (State.isOnline) UIToast.show('✅ Salvo!', 'success');
        Modal.close();
        if (State.isOnline) app.fetchData();
    },

    _payload() {
        const tipo = document.getElementById('type').value;

        // ── Origem (ENTRADA / DIVIDA / TRANSFERENCIA) ─────────
        const origemSel   = document.getElementById('origem-select')?.value  || '';
        const origemOutro = document.getElementById('origem-outro')?.value   || '';
        const origemVal   = origemSel === 'Outro' ? origemOutro : origemSel;

        // ── Categoria (SAIDA) ─────────────────────────────────
        const catSel   = document.getElementById('categoria')?.value   || '';
        const catOutro = document.getElementById('categoria-outro')?.value || '';
        const catVal   = catSel === 'Outro' ? catOutro : catSel;

        const origemDestino = tipo === 'SAIDA' ? catVal : origemVal;

        return {
            tipo,
            moeda:            document.getElementById('currency').value,
            valor:            parseFloat(document.getElementById('amount').value),
            origem_destino:   origemDestino,
            local_dinheiro:   document.getElementById('wallet').value,
            metodo:           document.getElementById('method').value,
            observacoes:      document.getElementById('notes').value || null,
            status:           document.getElementById('status').value || 'CONCLUIDO',
            data:             document.getElementById('tx-date').value,
            categoria:        catVal || null,
            parcela_atual:    parseInt(document.getElementById('parcela-atual').value) || 1,
            total_parcelas:   parseInt(document.getElementById('total-parcelas').value) || 1,
            is_reserva:       document.getElementById('is-reserva').checked,
            conciliado:       document.getElementById('conciliado').checked,
            taxa_cambio_dia:  State.exchangeRate,
            taxa_real:        parseFloat(document.getElementById('taxa-real').value) || null,
            valor_convertido: parseFloat(document.getElementById('valor-convertido').value) || null,
        };
    },

    async _saveInstallments(base) {
        if (base.total_parcelas <= 1) return await DB.insert(base);
        const [y, m, d] = base.data.split('-').map(Number);
        return await DB.insertMany(Array.from({ length: base.total_parcelas }, (_, i) => {
            const mi = (m - 1 + i) % 12, yi = Math.floor((m - 1 + i) / 12);
            return { ...base, parcela_atual: i + 1, data: `${y + yi}-${String(mi + 1).padStart(2,'0')}-${String(d).padStart(2,'0')}`, status: i === 0 ? (base.status || 'CONCLUIDO') : 'PENDENTE' };
        }));
    },

    async _saveTransfer(base) {
        const pid = crypto.randomUUID();
        const wDest = document.getElementById('wallet-dest').value;
        const mDest = document.getElementById('currency-dest').value;
        const vc    = parseFloat(document.getElementById('valor-convertido').value);
        return await DB.insertMany([
            { ...base, tipo: 'TRANSFERENCIA', status: 'CONCLUIDO', transferencia_id: pid, wallet_dest: wDest, moeda_dest: mDest },
            { tipo: 'TRANSFERENCIA', moeda: mDest, valor: vc > 0 ? vc : base.valor,
              origem_destino: `De: ${base.local_dinheiro}`, local_dinheiro: wDest,
              metodo: base.metodo, observacoes: base.observacoes, status: 'CONCLUIDO',
              data: base.data, transferencia_id: pid, taxa_cambio_dia: base.taxa_cambio_dia,
              taxa_real: base.taxa_real, valor_convertido: vc || null,
              is_reserva: false, conciliado: false, parcela_atual: 1, total_parcelas: 1 },
        ]);
    },
};

// ============================================================
// APP
// ============================================================
const app = {
    async init() {
        UIToast.init();
        UIConnStatus.update(navigator.onLine);
        OfflineQueue.init();
        this._setDefaultDate();
        UILoading.show();
        await ExchangeAPI.fetch();
        await this.fetchData();
        FormHandler.setup();
        this._registerSW();
    },

    _setDefaultDate() {
        const now   = new Date();
        const input = document.getElementById('filter-month');
        input.value    = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
        input.onchange = () => this.fetchData();
    },

    async fetchData() {
        const [year, month] = document.getElementById('filter-month').value.split('-');
        if (!year) return;
        State.transactions = await DB.fetchMonth(year, month);
        UITotals.update(State.transactions);
        UIDatalist.update(State.transactions);
        this._applyListFilter();
        if (document.getElementById('view-dashboard').classList.contains('active-view')) {
            UIDashboard.update(State.transactions);
        }
    },

    _applyListFilter() {
        let data = State.transactions;
        if (State.currentFilter !== 'TUDO') data = data.filter(t => t.tipo === State.currentFilter);
        UIList.render(data);
    },

    switchTab(tab, btnEl) {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        btnEl.classList.add('active');
        const isList = tab === 'lista';
        document.getElementById('view-lista').classList.toggle('active-view', isList);
        document.getElementById('view-lista').classList.toggle('hidden-view', !isList);
        document.getElementById('view-dashboard').classList.toggle('active-view', !isList);
        document.getElementById('view-dashboard').classList.toggle('hidden-view', isList);
        if (!isList) UIDashboard.update(State.transactions);
    },

    filterType(type, btnEl) {
        State.currentFilter = type;
        document.querySelectorAll('.filter-bar .chip').forEach(c => c.classList.remove('active'));
        btnEl.classList.add('active');
        this._applyListFilter();
    },

    toggleGroup(idx) {
        const body = document.getElementById(`body-group-${idx}`);
        const icon = document.getElementById(`icon-group-${idx}`);
        const open = body.classList.toggle('expanded');
        icon.style.transform = open ? 'rotate(180deg)' : '';
    },

    openModal(t)           { Modal.open(t); },
    closeModal()           { Modal.close(); },
    editTx(id)             { const t = State.transactions.find(x => x.id === id); if (t) Modal.populate(t); },
    onTypeChange()         { Modal.onTypeChange(); },
    onCurrencyChange()     { Modal.onCurrencyChange(); },
    onParcelasChange()     { Modal.onParcelasChange(); },
    onMethodChange()       { Modal.onMethodChange(); },
    onOrigemChange()       { Modal.onOrigemChange(); },
    onCategoriaChange()    { Modal.onCategoriaChange(); },
    onValorConvertidoChange() { Modal._updateRatePreview(); },
    fetchWiseQuote()       { return Modal.fetchWiseQuote(); },

    async deleteTx() {
        const id = document.getElementById('tx-id').value;
        if (!id || !confirm('Excluir este registro definitivamente?')) return;
        const err = await DB.delete(id);
        if (err) { UIToast.show('Erro: ' + err.message, 'danger'); return; }
        Modal.close();
        if (State.isOnline) this.fetchData();
    },

    setDashMoeda(m)   { State.dashMoeda  = m; UIDashboard.update(State.transactions); },
    printReport()     { PrintReport.print(); },
    setDashType(t)    { State.dashType   = t; UIDashboard.update(State.transactions); },
    renderDashboard() { State.dashOrigin = document.getElementById('dash-filter-origin').value; UIDashboard.update(State.transactions); },

    _registerSW() {
        if (!('serviceWorker' in navigator)) return;
        navigator.serviceWorker.register('sw.js')
            .then(reg => { if ('sync' in reg) reg.sync.register('sync-offline-queue').catch(() => {}); })
            .catch(e => console.warn('SW:', e));
        navigator.serviceWorker.addEventListener('message', e => {
            if (e.data?.type === 'SYNC_OFFLINE_QUEUE') OfflineQueue.drain();
        });
    },
};

// Inject spin animation
const _style = document.createElement('style');
_style.textContent = `@keyframes spin{to{transform:rotate(360deg)}} .spin{animation:spin 0.8s linear infinite;display:inline-block}`;
document.head.appendChild(_style);


// ============================================================
// PWA INSTALL BANNER
// Handles Android (beforeinstallprompt) + iOS (manual guide)
// ============================================================
const PWAInstall = {
    _deferredPrompt: null,
    _isIOS: /iphone|ipad|ipod/i.test(navigator.userAgent),
    _DISMISSED_KEY: 'pwa_install_dismissed',

    init() {
        // Don't show if already installed as PWA
        if (window.matchMedia('(display-mode: standalone)').matches) return;
        // Don't show if user dismissed recently (7 days)
        const ts = parseInt(localStorage.getItem(this._DISMISSED_KEY) || '0');
        if (Date.now() - ts < 7 * 24 * 60 * 60 * 1000) return;

        if (this._isIOS) {
            // iOS: show after a short delay
            setTimeout(() => this._showBanner('Toque em compartilhar → "Tela de Início"'), 2500);
        } else {
            // Android/Chrome: wait for browser event
            window.addEventListener('beforeinstallprompt', e => {
                e.preventDefault();
                this._deferredPrompt = e;
                setTimeout(() => this._showBanner('Acesse mais rápido pela tela de início'), 2000);
            });
        }
    },

    _showBanner(subText) {
        const banner = document.getElementById('install-banner');
        const sub    = document.getElementById('install-banner-sub');
        if (!banner) return;
        if (sub) sub.textContent = subText;
        banner.style.display = 'flex';
        // Nudge the main content up so the banner doesn't cover the FABs
        document.body.style.paddingBottom = (banner.offsetHeight + 8) + 'px';
    },

    _hideBanner() {
        const banner = document.getElementById('install-banner');
        if (banner) {
            banner.style.animation = 'none';
            banner.style.transition = 'transform 0.25s ease, opacity 0.25s ease';
            banner.style.transform  = 'translateY(100%)';
            banner.style.opacity    = '0';
            setTimeout(() => { banner.style.display = 'none'; }, 260);
        }
        document.body.style.paddingBottom = '';
    },

    dismiss() {
        localStorage.setItem(this._DISMISSED_KEY, String(Date.now()));
        this._hideBanner();
    },

    async install() {
        if (this._isIOS) {
            this._hideBanner();
            this._showIOSModal();
            return;
        }
        if (!this._deferredPrompt) return;
        this._deferredPrompt.prompt();
        const { outcome } = await this._deferredPrompt.userChoice;
        this._deferredPrompt = null;
        if (outcome === 'accepted') {
            UIToast.show('✅ App instalado com sucesso!', 'success', 4000);
        }
        this._hideBanner();
    },

    _showIOSModal() {
        const modal = document.createElement('div');
        modal.className = 'ios-install-modal';
        modal.innerHTML = `
            <div class="ios-install-modal__box">
                <h3>📲 Instalar no iPhone</h3>
                <ul class="ios-install-modal__steps">
                    <li>
                        <span class="step-num">1</span>
                        <span>Toque no botão de compartilhar
                              <strong style="color:#a5b4fc;">⎋</strong>
                              na barra do Safari (parte de baixo da tela)</span>
                    </li>
                    <li>
                        <span class="step-num">2</span>
                        <span>Role para baixo e toque em
                              <strong style="color:#a5b4fc;">"Adicionar à Tela de Início"</strong></span>
                    </li>
                    <li>
                        <span class="step-num">3</span>
                        <span>Toque em <strong style="color:#a5b4fc;">"Adicionar"</strong>
                              no canto superior direito</span>
                    </li>
                </ul>
                <button class="ios-install-modal__close" onclick="this.closest('.ios-install-modal').remove()">
                    Entendi
                </button>
            </div>`;
        document.body.appendChild(modal);
        modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
    },
};


// ============================================================
// PRINT REPORT — v2.0
// Respeita filtros ativos (lista e dashboard) + gráfico
// ============================================================
const PrintReport = {

    print() {
        // ── 1. Detecta qual view está ativa ──────────────────
        const isDash = document.getElementById('view-dashboard')
                           .classList.contains('active-view');
        isDash ? this._printDashboard() : this._printLista();
    },

    // ── PRINT LISTA ──────────────────────────────────────────
    _printLista() {
        const filter = State.currentFilter;   // TUDO | ENTRADA | GASTO_FIXO | …
        const txs    = filter === 'TUDO'
            ? State.transactions
            : State.transactions.filter(t => t.tipo === filter);

        const TLBL   = { TUDO:'Todas as Movimentações', ENTRADA:'Entradas',
                         SAIDA:'Saídas', GASTO_FIXO:'Gastos Fixos',
                         GASTO_VARIAVEL:'Gastos Variáveis',
                         DIVIDA:'Dívidas', TRANSFERENCIA:'Transferências' };
        const filterLabel = TLBL[filter] || filter;

        // P&L para este filtro
        const ent  = Calc.pl(txs, { tipo: 'ENTRADA', convertAll: true });
        const sai  = Math.abs(Calc.pl(txs, { tipo: 'SAIDA', convertAll: true }));
        const res  = ent - sai;
        const brlD = Calc.balance(txs, 'BRL', { onlyAvailable: true });
        const pygD = Calc.balance(txs, 'PYG', { onlyAvailable: true });
        const sign = (v, fn) => (v < 0 ? '−' : '') + fn(Math.abs(v));

        // Gráfico — despesas por categoria (filtro aplicado)
        const gastoTxs = txs.filter(t => TIPOS_GASTO.includes(t.tipo));
        const chartMap = {};
        gastoTxs.forEach(t => {
            const k = t.categoria || t.origem_destino || 'Outros';
            chartMap[k] = (chartMap[k] || 0) + (t.moeda === 'BRL' ? t.valor * Calc.txRate(t) : t.valor);
        });
        const chartTitle = filter === 'TUDO'
            ? 'Despesas por Categoria'
            : `Distribuição — ${filterLabel}`;

        const rows = this._buildRows(txs);
        const month = document.getElementById('filter-month').value;
        const label = this._monthLabel(month);

        this._openWindow({
            label, filterLabel,
            ent, sai, res, brlD, pygD, sign,
            rows, chartMap, chartTitle,
        });
    },

    // ── PRINT DASHBOARD ──────────────────────────────────────
    _printDashboard() {
        const origin = State.dashOrigin;
        const moeda  = State.dashMoeda;
        const tipo   = State.dashType;

        const MLBL = { BRL:'R$', PYG:'₲', MIX:'Todas as moedas' };
        const TLBL2 = { TUDO:'Tudo', ENTRADA:'Entradas', SAIDA:'Saídas',
                        GASTO_FIXO:'Gastos Fixos', GASTO_VARIAVEL:'Gastos Variáveis',
                        DIVIDA:'Dívidas' };

        // Aplica filtros do dashboard
        let txs = State.transactions;
        if (origin !== 'TUDO') txs = txs.filter(t => t.origem_destino === origin);
        if (moeda !== 'MIX')   txs = txs.filter(t => t.moeda === moeda);
        if (tipo  !== 'TUDO')  txs = txs.filter(t => t.tipo === tipo);

        const filterLabel = [
            origin !== 'TUDO' ? `Origem: ${origin}` : null,
            `Moeda: ${MLBL[moeda] || moeda}`,
            `Tipo: ${TLBL2[tipo] || tipo}`,
        ].filter(Boolean).join('  ·  ');

        const ent  = Calc.pl(txs, { tipo: 'ENTRADA', convertAll: true });
        const sai  = Math.abs(Calc.pl(txs, { tipo: 'SAIDA', convertAll: true }));
        const res  = ent - sai;
        const brlD = Calc.balance(State.transactions, 'BRL', { onlyAvailable: true });
        const pygD = Calc.balance(State.transactions, 'PYG', { onlyAvailable: true });
        const sign = (v, fn) => (v < 0 ? '−' : '') + fn(Math.abs(v));

        // Gráfico — igual ao dashboard ativo
        const gFn  = tipo === 'ENTRADA'
            ? t => t.origem_destino || 'Outros'
            : t => t.categoria || t.origem_destino || 'Outros';
        const chartMap = {};
        txs.filter(t => t.tipo !== 'TRANSFERENCIA').forEach(t => {
            const k = gFn(t);
            chartMap[k] = (chartMap[k] || 0) +
                (moeda === 'MIX' && t.moeda === 'BRL' ? t.valor * Calc.txRate(t) : t.valor);
        });
        const chartTitle = document.getElementById('chartOriginsTitle')?.textContent
            || 'Distribuição';

        const rows = this._buildRows(txs);
        const month = document.getElementById('filter-month').value;
        const label = this._monthLabel(month);

        this._openWindow({
            label, filterLabel,
            ent, sai, res, brlD, pygD, sign,
            rows, chartMap, chartTitle,
        });
    },

    // ── HELPERS ───────────────────────────────────────────────
    _monthLabel(month) {
        if (!month) return '';
        const [y, m] = month.split('-');
        const MONTHS = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho',
                        'Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
        return `${MONTHS[parseInt(m) - 1]} / ${y}`;
    },

    _buildRows(txs) {
        const TLBL = { ENTRADA:'Entrada', SAIDA:'Saída', GASTO_FIXO:'G.Fixo',
                       GASTO_VARIAVEL:'G.Variável', DIVIDA:'Dívida',
                       TRANSFERENCIA:'Transf.' };
        return [...txs].sort((a, b) => a.data < b.data ? -1 : 1).map(t => {
            const isIn = t.tipo === 'ENTRADA', isTr = t.tipo === 'TRANSFERENCIA';
            const c = isIn ? '#15803d' : isTr ? '#6366f1'
                    : t.tipo === 'DIVIDA' ? '#b45309' : '#dc2626';
            const s = isIn ? '+' : isTr ? '⇄' : '−';
            const parcela = t.total_parcelas > 1
                ? `<span style="font-size:8px;color:#6366f1;font-weight:700;margin-left:4px;">${t.parcela_atual}/${t.total_parcelas}</span>` : '';
            const status = (t.tipo === 'DIVIDA' || t.status === 'PENDENTE')
                ? `<span style="font-size:8px;background:#fef9c3;color:#854d0e;padding:1px 4px;border-radius:3px;margin-left:4px;">${t.status}</span>` : '';
            return `<tr>
                <td>${fmt.date(t.data)}</td>
                <td style="color:${c};font-weight:700">${TLBL[t.tipo] || t.tipo}</td>
                <td>${t.origem_destino || '—'}${parcela}${status}</td>
                <td>${t.categoria || '—'}</td>
                <td>${t.local_dinheiro || '—'}</td>
                <td>${t.metodo || '—'}</td>
                <td style="text-align:right;font-weight:600;color:${c}">${s} ${fmt.money(t.valor, t.moeda)}</td>
                <td style="text-align:center">${t.conciliado ? '✓' : t.status === 'PENDENTE' ? '⏳' : ''}</td>
            </tr>`;
        }).join('');
    },

    _openWindow({ label, filterLabel, ent, sai, res, brlD, pygD, sign, rows, chartMap, chartTitle }) {
        const taxa    = State.exchangeRate;
        const COLORS  = Config.CHART_COLORS;
        const cLabels = Object.keys(chartMap);
        const cData   = Object.values(chartMap);
        const total   = cData.reduce((a, b) => a + b, 0);

        // Legend HTML for print
        const legendHTML = cLabels.map((l, i) => {
            const v = cData[i], c = COLORS[i % COLORS.length];
            const pct = total > 0 ? ((v / total) * 100).toFixed(1) : '0';
            return `<div style="display:flex;justify-content:space-between;align-items:center;padding:3px 0;border-bottom:1px solid #f1f5f9">
                <div style="display:flex;align-items:center;gap:7px">
                    <div style="width:10px;height:10px;border-radius:2px;background:${c};flex-shrink:0"></div>
                    <span style="font-size:10px">${l}</span>
                </div>
                <div style="text-align:right">
                    <span style="font-size:10px;font-weight:700">${fmt.pyg(v)}</span>
                    <span style="font-size:8px;color:#94a3b8;margin-left:6px">${pct}%</span>
                </div>
            </div>`;
        }).sort().join('');

        const html = `<!DOCTYPE html><html lang="pt-br"><head>
<meta charset="UTF-8">
<title>Relatório — ${label} — ${filterLabel}</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"><\/script>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Segoe UI',Arial,sans-serif;font-size:11px;color:#1e1b4b;padding:16px}
.hdr{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #4f46e5;padding-bottom:10px;margin-bottom:14px}
.hdr-title{font-size:18px;font-weight:800;color:#4f46e5}
.hdr-period{font-size:12px;color:#6366f1;font-weight:600;margin-top:2px}
.hdr-filter{font-size:9px;color:#fff;background:#6366f1;padding:2px 8px;border-radius:10px;margin-top:4px;display:inline-block}
.hdr-meta{font-size:9px;color:#94a3b8;text-align:right}
.cards{display:grid;grid-template-columns:repeat(5,1fr);gap:6px;margin-bottom:14px}
.card{border:1.5px solid #e0e7ff;border-radius:8px;padding:7px 9px}
.card h4{font-size:7px;text-transform:uppercase;letter-spacing:.06em;color:#94a3b8;margin-bottom:3px}
.card strong{font-size:12px;font-weight:800;display:block}
.card small{font-size:7px;color:#94a3b8;margin-top:1px;display:block}
.green strong{color:#15803d}.red strong{color:#dc2626}.blue strong{color:#1d4ed8}.purple strong{color:#4f46e5}.amber strong{color:#b45309}
.section-title{font-size:11px;font-weight:700;color:#4f46e5;margin:12px 0 6px;padding-bottom:3px;border-bottom:1.5px solid #e0e7ff}
.chart-section{display:grid;grid-template-columns:180px 1fr;gap:16px;margin-bottom:14px;align-items:start}
.chart-wrap{position:relative;width:180px;height:180px}
.chart-legend{flex:1}
table{width:100%;border-collapse:collapse;font-size:10px}
thead tr{background:#4f46e5;color:#fff}
thead th{padding:5px 6px;text-align:left;font-weight:600;font-size:8.5px}
tbody tr{border-bottom:1px solid #f1f5f9}
tbody tr:nth-child(even){background:#f8fafc}
td{padding:4px 6px;vertical-align:middle}
.footer{margin-top:12px;padding-top:7px;border-top:1px solid #e0e7ff;font-size:8px;color:#94a3b8;display:flex;justify-content:space-between}
@media print{
  @page{margin:10mm 8mm;size:A4 portrait}
  body{padding:0}
  .chart-section{break-inside:avoid}
}
</style></head><body>

<div class="hdr">
  <div>
    <div class="hdr-title">💰 Finanças Família Morais</div>
    <div class="hdr-period">${label}</div>
    <span class="hdr-filter">Filtro: ${filterLabel}</span>
  </div>
  <div class="hdr-meta">
    Gerado em ${new Date().toLocaleString('pt-BR')}<br>
    Câmbio: R$1 = ₲ ${taxa.toFixed(0)}
  </div>
</div>

<div class="cards">
  <div class="card green"><h4>Receitas</h4><strong>${fmt.pyg(ent)}</strong><small>em ₲</small></div>
  <div class="card red"><h4>Despesas</h4><strong>${fmt.pyg(sai)}</strong><small>em ₲</small></div>
  <div class="card ${res >= 0 ? 'blue' : 'red'}"><h4>Resultado</h4><strong>${sign(res, fmt.pyg)}</strong><small>${res >= 0 ? 'Superávit' : 'Déficit'}</small></div>
  <div class="card purple"><h4>Saldo R$</h4><strong>${sign(brlD, fmt.brl)}</strong><small>disponível</small></div>
  <div class="card amber"><h4>Saldo ₲</h4><strong>${sign(pygD, fmt.pyg)}</strong><small>disponível</small></div>
</div>

${cLabels.length > 0 ? `
<div class="section-title">📊 ${chartTitle}</div>
<div class="chart-section">
  <div class="chart-wrap">
    <canvas id="printChart" width="180" height="180"></canvas>
  </div>
  <div class="chart-legend">${legendHTML}</div>
</div>` : ''}

<div class="section-title">📋 Movimentações (${rows.split('<tr>').length - 1} registros)</div>
<table>
  <thead>
    <tr>
      <th>Data</th><th>Tipo</th><th>Origem/Destino</th><th>Categoria</th>
      <th>Carteira</th><th>Método</th><th style="text-align:right">Valor</th><th>St.</th>
    </tr>
  </thead>
  <tbody>${rows}</tbody>
</table>

<div class="footer">
  <span>maycomorais.github.io/nossas-finan-as · ${label} · ${filterLabel}</span>
  <span>Câmbio ₲ ${taxa.toFixed(0)}/R$ na data de geração</span>
</div>

<script>
window.onload = function() {
  ${cLabels.length > 0 ? `
  var ctx = document.getElementById('printChart').getContext('2d');
  new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: ${JSON.stringify(cLabels)},
      datasets: [{
        data: ${JSON.stringify(cData)},
        backgroundColor: ${JSON.stringify(COLORS.slice(0, cLabels.length))},
        borderWidth: 2,
        borderColor: '#fff',
        hoverOffset: 0,
      }]
    },
    options: {
      responsive: false,
      cutout: '58%',
      animation: { onComplete: function() { window.print(); } },
      plugins: {
        legend: { display: false },
        tooltip: { enabled: false },
      }
    }
  });` : 'window.print();'}
};
<\/script>
</body></html>`;

        const win = window.open('', '_blank', 'width=960,height=760');
        if (!win) { UIToast.show('⚠️ Permita pop-ups para imprimir', 'warning', 5000); return; }
        win.document.write(html);
        win.document.close();
    },
};

window.app = app;
PWAInstall.init();
app.init();