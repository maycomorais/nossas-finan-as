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
        const { data, error } = await _sb
            .from('transacoes').select('*')
            .gte('data', `${year}-${month}-01`)
            .lte('data', `${year}-${month}-31`)
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

        this._anim('balance-brl',   fmt.brl(brlD));
        this._anim('balance-pyg',   fmt.pyg(pygD));
        this._anim('balance-total', fmt.pyg(total));

        document.getElementById('balance-brl-reserva').textContent = brlR !== 0 ? `+ ${fmt.brl(brlR)} caixinha` : '';
        const mgRate = taxa * (1 - Config.MONEYGRAM_SPREAD);
        const mgEl   = document.getElementById('balance-brl-mg');
        if (mgEl) mgEl.textContent = brlD !== 0 ? `≈ ${fmt.pyg(brlD * mgRate)} (MG)` : '';
        document.getElementById('balance-pyg-reserva').textContent = pygR !== 0 ? `+ ${fmt.pyg(pygR)} caixinha` : '';
        document.getElementById('balance-patrimonio').textContent  = `Patrimônio: ${fmt.pyg(patrim)}`;
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
        const sai = Calc.pl(filtered, { tipo: 'SAIDA',   convertAll: true });
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
            // categoria_select e origem_select: descomente após rodar migration.sql no Supabase
            // categoria_select: catSel || null,
            // origem_select:    origemSel || null,
            // tipo_divida: descomente após rodar migration.sql no Supabase
            // tipo_divida: tipo === 'DIVIDA' ? (document.getElementById('tipo-divida')?.value || null) : null,
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

window.app = app;
PWAInstall.init();
app.init();