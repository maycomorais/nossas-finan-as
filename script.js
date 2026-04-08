/* ============================================================
   FINANÇAS FAMÍLIA — script.js v4.0
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
    EXCHANGE_URL:  'https://economia.awesomeapi.com.br/last/BRL-PYG,USD-BRL,USD-PYG',
    FALLBACK_RATE: 1420,
    FALLBACK_USD_BRL: 5.70,
    FALLBACK_USD_PYG: 8100,
    OFFLINE_KEY:   'fm_offline_queue_v1',
    MONEYGRAM_SPREAD: 0.0618,
    CHART_COLORS:  [
        '#ef4444','#f97316','#eab308','#22c55e','#3b82f6',
        '#8b5cf6','#ec4899','#14b8a6','#f43f5e','#6366f1',
        '#84cc16','#0ea5e9','#a855f7','#fb923c','#34d399',
    ],
    INTL_METHODS: ['Wise', 'Moneygram', 'Transferência'],
    // Carteiras que podem ter saldo negativo (cartões de crédito)
    CREDIT_CARD_WALLETS: ['Cartão', 'Nubank', 'Itaú', 'Bradesco', 'Santander', 'C6', 'Inter', 'XP'],
    // Wise mantém saldo em USD
    USD_WALLETS: ['Wise'],
};

const _sb = supabase.createClient(Config.SB_URL, Config.SB_KEY);

// ============================================================
// FORMATTERS
// ============================================================
const fmt = {
    brl:   v => `R$ ${Math.abs(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
    pyg:   v => `₲ ${Math.abs(v).toLocaleString('es-PY', { maximumFractionDigits: 0 })}`,
    usd:   v => `$ ${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
    money: (v, moeda) => moeda === 'BRL' ? fmt.brl(v) : moeda === 'USD' ? fmt.usd(v) : fmt.pyg(v),
    date:  d => d ? d.split('-').reverse().join('/') : '—',
    pct:   (v, t) => t > 0 ? ((v / t) * 100).toFixed(1) + '%' : '—',
};

// ============================================================
// CONSTANTS
// ============================================================
const TIPOS_GASTO = ['SAIDA', 'GASTO_FIXO', 'GASTO_VARIAVEL', 'DIVIDA'];

// Status que EFETIVA o movimento de caixa para gastos
const STATUS_PAGO = ['PAGO', 'CONCLUIDO', 'QUITADA'];

// ============================================================
// STATE
// ============================================================
const State = {
    transactions:  [],   // mês atual (excl. AGUARDANDO)
    futureIncome:  [],   // AGUARDANDO (receitas futuras)
    debts:         [],   // PENDENTE de meses anteriores (dívidas acumuladas)
    exchangeRate:  Config.FALLBACK_RATE,
    usdBrlRate:    Config.FALLBACK_USD_BRL,
    usdPygRate:    Config.FALLBACK_USD_PYG,
    currentFilter: 'TUDO',
    dashMoeda:     'BRL',
    dashType:      'SAIDA',
    dashOrigin:    'TUDO',
    charts:        {},
    isOnline:      navigator.onLine,
    walletBalances: {},  // { walletName: { BRL, PYG, USD } }
};

// ============================================================
// EXCHANGE RATE API
// ============================================================
const ExchangeAPI = {
    async fetch() {
        try {
            const res  = await fetch(Config.EXCHANGE_URL);
            const data = await res.json();
            if (data?.BRLPYG?.bid)  State.exchangeRate = parseFloat(data.BRLPYG.bid);
            if (data?.USDBRL?.bid)  State.usdBrlRate   = parseFloat(data.USDBRL.bid);
            if (data?.USDPYG?.bid)  State.usdPygRate   = parseFloat(data.USDPYG.bid);
            this._updateBadge();
            return;
        } catch (_) {}

        try {
            const res  = await fetch('https://open.er-api.com/v6/latest/BRL');
            const data = await res.json();
            if (data?.rates?.PYG) State.exchangeRate = data.rates.PYG * 0.98;
            if (data?.rates?.USD) State.usdBrlRate   = 1 / data.rates.USD;
        } catch (_) {
            console.warn('ExchangeAPI: usando fallback');
        }
        this._updateBadge();
    },

    _updateBadge() {
        const el = document.getElementById('cambio-valor');
        if (el) el.textContent = `R$1 = ₲${State.exchangeRate.toFixed(0)} · $1 = R$${State.usdBrlRate.toFixed(2)}`;
    },

    // Converte qualquer valor para PYG para totais unificados
    toPYG(valor, moeda) {
        if (moeda === 'PYG') return valor;
        if (moeda === 'BRL') return valor * State.exchangeRate;
        if (moeda === 'USD') return valor * State.usdPygRate;
        return valor;
    },

    toBRL(valor, moeda) {
        if (moeda === 'BRL') return valor;
        if (moeda === 'PYG') return valor / State.exchangeRate;
        if (moeda === 'USD') return valor * State.usdBrlRate;
        return valor;
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

    // Busca GASTO_FIXO e GASTO_VARIAVEL PENDENTES de meses anteriores (dívidas acumuladas)
    async fetchPendingDebts(year, month) {
        if (!State.isOnline) return [];
        const firstDayCurrent = `${year}-${month}-01`;
        const { data, error } = await _sb
            .from('transacoes').select('*')
            .in('tipo', ['GASTO_FIXO', 'GASTO_VARIAVEL', 'DIVIDA'])
            .eq('status', 'PENDENTE')
            .lt('data', firstDayCurrent)
            .order('data', { ascending: false });
        if (error) { console.error('DB.fetchPendingDebts:', error); return []; }
        return data || [];
    },

    async fetchFutureIncome() {
        if (!State.isOnline) return [];
        const { data, error } = await _sb
            .from('transacoes').select('*')
            .eq('tipo', 'ENTRADA')
            .eq('status', 'AGUARDANDO')
            .order('data', { ascending: true });
        if (error) { console.error('DB.fetchFutureIncome:', error); return []; }
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

    // Verifica se um gasto foi efetivado no caixa
    _gastoEfetivado(t) {
        if (t.tipo === 'ENTRADA') return true;  // entradas têm sua própria lógica
        if (t.tipo === 'SAIDA')   return true;  // legado: sempre efetivado
        if (t.tipo === 'DIVIDA')  return STATUS_PAGO.includes(t.status);
        if (t.tipo === 'GASTO_FIXO' || t.tipo === 'GASTO_VARIAVEL') {
            return STATUS_PAGO.includes(t.status);
        }
        return true;
    },

    balance(txs, moeda, { onlyAvailable = true } = {}) {
        return txs.filter(t => {
            if (t.tipo === 'TRANSFERENCIA')  return false;
            if (t.status === 'AGUARDANDO')   return false;
            if (onlyAvailable && t.is_reserva) return false;
            if (t.moeda !== moeda)           return false;
            // Para entradas: conta normalmente
            if (t.tipo === 'ENTRADA')        return true;
            // Para gastos: só conta se efetivado (PAGO/CONCLUIDO)
            return this._gastoEfetivado(t);
        }).reduce((acc, t) => acc + (t.tipo === 'ENTRADA' ? t.valor : -t.valor), 0);
    },

    // Saldo de uma carteira específica (para dropdown filtering)
    walletBalance(txs, walletName) {
        const walletTxs = txs.filter(t =>
            t.local_dinheiro === walletName && t.tipo !== 'TRANSFERENCIA'
        );
        return {
            BRL: this.balance(walletTxs, 'BRL', { onlyAvailable: false }),
            PYG: this.balance(walletTxs, 'PYG', { onlyAvailable: false }),
            USD: this.balance(walletTxs, 'USD', { onlyAvailable: false }),
        };
    },

    balanceReserva: (txs, moeda) =>
        txs.filter(t => t.tipo !== 'TRANSFERENCIA' && t.moeda === moeda && t.is_reserva)
           .reduce((acc, t) => acc + (t.tipo === 'ENTRADA' ? t.valor : -t.valor), 0),

    // Total comprometido (soma de PENDENTES do mês + dívidas acumuladas)
    totalComprometido(txsMes, debts) {
        const pendentes = txsMes.filter(t =>
            (t.tipo === 'GASTO_FIXO' || t.tipo === 'GASTO_VARIAVEL') &&
            t.status === 'PENDENTE'
        );

        const fixos    = pendentes.filter(t => t.tipo === 'GASTO_FIXO')
            .reduce((a, t) => a + ExchangeAPI.toPYG(t.valor, t.moeda), 0);
        const variaveis = pendentes.filter(t => t.tipo === 'GASTO_VARIAVEL')
            .reduce((a, t) => a + ExchangeAPI.toPYG(t.valor, t.moeda), 0);
        const dividasAcc = debts.reduce((a, t) => a + ExchangeAPI.toPYG(t.valor, t.moeda), 0);

        return { fixos, variaveis, dividasAcc, total: fixos + variaveis + dividasAcc };
    },

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
        const showFuture = State.currentFilter === 'TUDO' || State.currentFilter === 'RECEITA_FUTURA';
        const hasFuture  = State.futureIncome?.length > 0;
        const showDebts  = (State.currentFilter === 'TUDO' || State.currentFilter === 'DIVIDA')
                           && State.debts?.length > 0;

        if (!data.length && !(showFuture && hasFuture) && !(showDebts)) {
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

        const futureSect = (showFuture && hasFuture) ? this._futureIncomeSection(State.futureIncome) : '';
        const debtsSect  = showDebts ? this._debtsSection(State.debts) : '';

        list.innerHTML = futureSect + debtsSect + concBanner +
            Object.keys(groups).map((k, i) => this._groupCard(k, groups[k], i)).join('');
    },

    renderFutureOnly() {
        const list = document.getElementById('transaction-list');
        if (!State.futureIncome?.length) {
            list.innerHTML = `
                <div class="empty-state">
                    <span class="material-symbols-rounded">event_available</span>
                    <p>Nenhuma receita aguardando confirmação</p>
                </div>`;
            return;
        }
        list.innerHTML = this._futureIncomeSection(State.futureIncome);
    },

    renderDebtsOnly() {
        const list = document.getElementById('transaction-list');
        const allDebts = [
            ...State.debts,
            ...State.transactions.filter(t =>
                (t.tipo === 'GASTO_FIXO' || t.tipo === 'GASTO_VARIAVEL' || t.tipo === 'DIVIDA')
                && t.status === 'PENDENTE'
            ),
        ];
        if (!allDebts.length) {
            list.innerHTML = `
                <div class="empty-state">
                    <span class="material-symbols-rounded">check_circle</span>
                    <p>Nenhuma dívida ou pendência! 🎉</p>
                </div>`;
            return;
        }
        list.innerHTML = this._debtsSection(State.debts, true) +
            this._pendentesSection(State.transactions.filter(t =>
                (t.tipo === 'GASTO_FIXO' || t.tipo === 'GASTO_VARIAVEL')
                && t.status === 'PENDENTE'
            ));
    },

    // Seção de dívidas roladas de meses anteriores
    _debtsSection(items) {
        if (!items.length) return '';
        const total = items.reduce((a, t) => a + ExchangeAPI.toPYG(t.valor, t.moeda), 0);
        const rows = items.map(t => `
            <div class="debt-item">
                <div class="debt-item-icon">⏳</div>
                <div class="card-info">
                    <div class="tx-title">${this._esc(t.origem_destino || t.categoria || '—')}</div>
                    <div class="tx-sub">${fmt.date(t.data)} · ${this._esc(t.local_dinheiro || '—')} · <em>${t.tipo === 'GASTO_FIXO' ? 'Fixo' : 'Variável'}</em></div>
                    ${t.observacoes ? `<div class="tx-sub tx-obs">"${this._esc(t.observacoes)}"</div>` : ''}
                </div>
                <div class="card-value">
                    <div class="val minus">${fmt.money(t.valor, t.moeda)}</div>
                    <div class="tx-date">${fmt.date(t.data)}</div>
                </div>
                <button class="btn-pay-icon" onclick="app.markAsPaid('${t.id}')" title="Marcar como Pago">
                    <span class="material-symbols-rounded">check_circle</span>
                </button>
            </div>`).join('');

        return `
        <div class="debts-section">
            <div class="debts-section-header" onclick="this.parentElement.classList.toggle('expanded')">
                <span class="material-symbols-rounded">expand_more</span>
                <span class="material-symbols-rounded" style="font-size:16px;color:#f59e0b;">warning</span>
                <span>Dívidas de meses anteriores <strong>(${items.length})</strong></span>
                <span class="debts-total">${fmt.pyg(total)}</span>
            </div>
            <div class="debts-body">
                ${rows}
            </div>
        </div>`;
    },

    // Seção de gastos pendentes do mês atual (no filtro DIVIDA)
    _pendentesSection(items) {
        if (!items.length) return '';
        return `
        <div class="debts-section" style="border-color:#e0e7ff;">
            <div class="debts-section-header" style="background:linear-gradient(90deg,#4f46e5,#6366f1);"
                 onclick="this.parentElement.classList.toggle('expanded')">
                <span class="material-symbols-rounded">expand_more</span>
                <span class="material-symbols-rounded" style="font-size:16px;">pending_actions</span>
                <span>Pendentes do mês <strong>(${items.length})</strong></span>
            </div>
            <div class="debts-body">
                ${items.map(t => this._txItem(t, true)).join('')}
            </div>
        </div>`;
    },

    // Seção de receitas futuras como accordion (padronizado)
    _futureIncomeSection(items) {
        const total = items.reduce((acc, t) => {
            return acc + ExchangeAPI.toPYG(t.valor, t.moeda);
        }, 0);
        const rows = items.map(t => `
            <div class="future-income-item">
                <div class="future-income-info">
                    <div class="future-income-origin">${this._esc(t.origem_destino || '—')}</div>
                    <div class="future-income-meta">${fmt.date(t.data)} · ${t.local_dinheiro || '—'}</div>
                    ${t.observacoes ? `<div class="future-income-obs">"${this._esc(t.observacoes)}"</div>` : ''}
                </div>
                <div class="future-income-right">
                    <div class="future-income-val">${fmt.money(t.valor, t.moeda)}</div>
                    <div class="future-income-actions">
                        <button class="future-btn future-btn--confirm" onclick="app.confirmFutureIncome('${t.id}')" title="Confirmar recebimento">
                            <span class="material-symbols-rounded">check_circle</span>
                        </button>
                        <button class="future-btn future-btn--postpone" onclick="app.postponeFutureIncome('${t.id}')" title="Adiar">
                            <span class="material-symbols-rounded">update</span>
                        </button>
                        <button class="future-btn future-btn--cancel" onclick="app.cancelFutureIncome('${t.id}')" title="Cancelar">
                            <span class="material-symbols-rounded">cancel</span>
                        </button>
                    </div>
                </div>
            </div>`).join('');

        return `
        <div class="future-income-section">
            <div class="future-income-header" onclick="this.parentElement.classList.toggle('expanded')">
                <span class="material-symbols-rounded expand-icon">expand_more</span>
                <span class="material-symbols-rounded" style="font-size:16px;">pending_actions</span>
                <span>Ganhos Futuros Aguardando <strong>(${items.length})</strong></span>
                <span class="future-income-total">${fmt.pyg(total)}</span>
            </div>
            <div class="future-income-body">
                ${rows}
            </div>
        </div>`;
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

    _txItem(t, forcePayBtn = false) {
        const isTr  = t.tipo === 'TRANSFERENCIA';
        const isIn  = t.tipo === 'ENTRADA';
        const isGF  = t.tipo === 'GASTO_FIXO';
        const isGV  = t.tipo === 'GASTO_VARIAVEL';
        const isDt  = t.tipo === 'DIVIDA';
        const isOut = t.tipo === 'SAIDA';
        const isPending = t.status === 'PENDENTE';

        let iconCls = 'out', iconSym = '↓';
        if (isTr) { iconCls = 'transfer'; iconSym = '⇄'; }
        else if (isIn)  { iconCls = 'in';   iconSym = '↑'; }
        else if (isGF)  { iconCls = 'gf';   iconSym = '🔄'; }
        else if (isGV)  { iconCls = 'gv';   iconSym = '📦'; }
        else if (isDt)  { iconCls = 'debt'; iconSym = '⏳'; }

        const valCls  = isTr ? 'transfer' : isIn ? 'plus' : 'minus';
        const sub = [
            t.local_dinheiro,
            t.metodo,
            t.categoria,
            isTr && t.wallet_dest ? `→ ${t.wallet_dest}` : null,
            t.currency_deducted ? `−$${parseFloat(t.currency_deducted).toFixed(2)} USD` : null,
        ].filter(Boolean).join(' · ');

        const badges = [
            t.total_parcelas > 1          ? `<span class="parcela-badge">${t.parcela_atual}/${t.total_parcelas}</span>` : '',
            isPending                     ? `<span class="status-badge status-PENDENTE">⏳ Pendente</span>` : '',
            STATUS_PAGO.includes(t.status) && !isIn && !isTr && !isOut
                                          ? `<span class="status-badge status-PAGA">✅ Pago</span>` : '',
            t.is_reserva                  ? `<span class="status-badge status-reserva">🐷 Caixinha</span>` : '',
            t.conciliado                  ? `<span class="status-badge status-conciliado">✓ Conc.</span>` : '',
            t.taxa_cambio_dia             ? `<span class="taxa-tag" title="Taxa histórica">₲${parseFloat(t.taxa_cambio_dia).toFixed(0)}</span>` : '',
        ].join('');

        const photo = t.comprovante_url
            ? `<span class="material-symbols-rounded has-photo" onclick="window.open('${t.comprovante_url}')" title="Ver comprovante">image</span>` : '';

        // Botão "Marcar como Pago" para gastos PENDENTES
        const showPayBtn = (isGF || isGV || isDt) && isPending;
        const payBtn = showPayBtn
            ? `<button class="btn-pay-icon" onclick="app.markAsPaid('${t.id}')" title="Marcar como Pago">
                   <span class="material-symbols-rounded">check_circle</span>
               </button>` : '';

        return `
        <div class="tx-item ${t.conciliado ? 'tx-item--conciliado' : ''} ${isPending ? 'tx-item--pendente' : ''}">
            <div class="tx-icon tx-icon--${iconCls}">${iconSym}</div>
            <div class="card-info">
                <div class="tx-title">${this._esc(t.origem_destino || t.categoria || '—')} ${photo}</div>
                <div class="tx-sub">${this._esc(sub)}</div>
                ${t.observacoes ? `<div class="tx-sub tx-obs">"${this._esc(t.observacoes)}"</div>` : ''}
                <div class="tx-badges">${badges}</div>
            </div>
            <div class="card-value">
                <div class="val ${valCls}">${fmt.money(t.valor, t.moeda)}</div>
                <div class="tx-date">${fmt.date(t.data)}</div>
            </div>
            ${payBtn}
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
        const usdD   = Calc.balance(txs, 'USD', { onlyAvailable: true });
        const brlR   = Calc.balanceReserva(txs, 'BRL');
        const pygR   = Calc.balanceReserva(txs, 'PYG');
        const total  = pygD + brlD * taxa + usdD * State.usdPygRate;
        const patrim = total + pygR + brlR * taxa;

        const signedBrl = v => (v < 0 ? '−' : '') + fmt.brl(v);
        const signedPyg = v => (v < 0 ? '−' : '') + fmt.pyg(v);

        this._anim('balance-brl',   signedBrl(brlD));
        this._anim('balance-pyg',   signedPyg(pygD));
        this._anim('balance-total', signedPyg(total));

        const elBrl   = document.getElementById('balance-brl');
        const elPyg   = document.getElementById('balance-pyg');
        const elTotal = document.getElementById('balance-total');
        if (elBrl)   elBrl.style.color   = brlD  < 0 ? '#fca5a5' : '';
        if (elPyg)   elPyg.style.color   = pygD  < 0 ? '#fca5a5' : '';
        if (elTotal) elTotal.style.color = total < 0 ? '#fca5a5' : '';

        document.getElementById('balance-brl-reserva').textContent = brlR !== 0 ? `+ ${fmt.brl(brlR)} caixinha` : '';
        const mgRate = taxa * (1 - Config.MONEYGRAM_SPREAD);
        const mgEl   = document.getElementById('balance-brl-mg');
        if (mgEl) {
            let sub = '';
            if (brlD !== 0) sub += `≈ ${signedPyg(brlD * mgRate)} (MG)`;
            if (usdD !== 0) sub += (sub ? ' · ' : '') + `+ ${fmt.usd(usdD)} Wise`;
            mgEl.textContent = sub;
        }
        document.getElementById('balance-pyg-reserva').textContent = pygR !== 0 ? `+ ${fmt.pyg(pygR)} caixinha` : '';
        document.getElementById('balance-patrimonio').textContent  = `Patrimônio: ${signedPyg(patrim)}`;

        // Comprometido row
        const comp = Calc.totalComprometido(txs, State.debts);
        this._anim('comp-fixos',    fmt.pyg(comp.fixos));
        this._anim('comp-variaveis', fmt.pyg(comp.variaveis));
        this._anim('comp-dividas',  fmt.pyg(comp.dividasAcc));
        this._anim('comp-total',    fmt.pyg(comp.total));

        // Armazena balances por carteira para dropdown
        const wallets = [...new Set(txs.map(t => t.local_dinheiro).filter(Boolean))];
        State.walletBalances = {};
        wallets.forEach(w => { State.walletBalances[w] = Calc.walletBalance(txs, w); });
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

        // Total Comprometido card
        this._renderComprometido(txs, State.debts);

        this._biggestExpense(filtered);
        this._concilStats(filtered);
        this._updateOriginSelect(txs);

        ['brl','pyg','mix'].forEach(m =>
            document.getElementById(`dash-btn-${m}`)?.classList.toggle('active', State.dashMoeda === m.toUpperCase()));
        ['tudo','entrada','saida','divida'].forEach(t =>
            document.getElementById(`dash-btn-${t}`)?.classList.toggle('active', State.dashType === t.toUpperCase()));

        this._renderChart(filtered);
    },

    _renderComprometido(txs, debts) {
        const comp = Calc.totalComprometido(txs, debts);
        const el   = document.getElementById('dash-comp-total');
        if (el) el.textContent = fmt.pyg(comp.total);

        const bd = document.getElementById('comprometido-dash-breakdown');
        if (!bd) return;
        bd.innerHTML = comp.total === 0 ? '<span style="font-size:0.8rem;color:#94a3b8;">Nenhum gasto pendente 🎉</span>' : `
            <div class="comp-breakdown-item">
                <span>🔄 Gastos Fixos (pendente)</span>
                <strong>${fmt.pyg(comp.fixos)}</strong>
            </div>
            <div class="comp-breakdown-item">
                <span>📦 Gastos Variáveis (pendente)</span>
                <strong>${fmt.pyg(comp.variaveis)}</strong>
            </div>
            <div class="comp-breakdown-item comp-breakdown-item--debt">
                <span>⏳ Dívidas acumuladas</span>
                <strong>${fmt.pyg(comp.dividasAcc)}</strong>
            </div>`;
    },

    _biggestExpense(txs) {
        const map = {};
        txs.filter(t => TIPOS_GASTO.includes(t.tipo)).forEach(t => {
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
            chartData = [Calc.pl(txs, { tipo: 'ENTRADA', convertAll: true }), Math.abs(Calc.pl(txs, { tipo: 'SAIDA', convertAll: true }))];
            title     = 'Visão Global (Guaranis)';
        } else {
            const tiposFiltro = tipo === 'DIVIDA'
                ? ['GASTO_FIXO', 'GASTO_VARIAVEL', 'DIVIDA']
                : [tipo];
            const base = txs.filter(t => t.tipo !== 'TRANSFERENCIA' && tiposFiltro.includes(t.tipo) && (moeda === 'MIX' || t.moeda === moeda));
            const gFn  = tipo === 'ENTRADA' ? t => t.origem_destino || 'Outros' : t => t.categoria || t.origem_destino || 'Outros';
            const map  = {};
            base.forEach(t => { const k = gFn(t); map[k] = (map[k] || 0) + (moeda === 'MIX' && t.moeda === 'BRL' ? t.valor * Calc.txRate(t) : t.valor); });
            labels    = Object.keys(map);
            chartData = Object.values(map);
            const tL  = tipo === 'ENTRADA' ? 'Receitas' : tipo === 'SAIDA' ? 'Despesas' : 'Gastos/Dívidas';
            const mL  = moeda === 'BRL' ? 'R$' : moeda === 'PYG' ? '₲' : '₲ (tudo)';
            title     = `${tL} por Categoria (${mL})`;
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
        const allWallets = [...new Set(txs.map(t => t.local_dinheiro).filter(Boolean))];

        // Para saídas: apenas carteiras com saldo positivo OU cartões de crédito
        const expenseWallets = allWallets.filter(w => {
            if (Config.CREDIT_CARD_WALLETS.some(cc => w.toLowerCase().includes(cc.toLowerCase()))) return true;
            const bal = State.walletBalances[w];
            if (!bal) return true; // incluir se desconhecido
            return (bal.BRL > 0 || bal.PYG > 0 || bal.USD > 0);
        });

        const fill = (id, items) => {
            const el = document.getElementById(id);
            if (el) el.innerHTML = items.map(v => `<option value="${v}">`).join('');
        };

        // Armazena para uso no modal
        State._allWallets     = allWallets;
        State._expenseWallets = expenseWallets;

        fill('list-wallets',      allWallets);
        fill('list-wallets-dest', allWallets);
    },

    // Atualiza o datalist com base no tipo de transação
    filterForType(tipo) {
        const isExpense = ['SAIDA', 'GASTO_FIXO', 'GASTO_VARIAVEL'].includes(tipo);
        const wallets   = isExpense ? (State._expenseWallets || State._allWallets || []) : (State._allWallets || []);
        const el = document.getElementById('list-wallets');
        if (el) el.innerHTML = wallets.map(v => `<option value="${v}">`).join('');

        // Hint de saldo
        const walletInput = document.getElementById('wallet');
        if (walletInput?.value) this.updateWalletHint(walletInput.value);
    },

    updateWalletHint(walletName) {
        const hint = document.getElementById('wallet-balance-hint');
        if (!hint) return;
        const bal = State.walletBalances?.[walletName];
        if (!bal) { hint.textContent = ''; return; }
        const parts = [];
        if (bal.BRL !== 0) parts.push(fmt.brl(bal.BRL));
        if (bal.PYG !== 0) parts.push(fmt.pyg(bal.PYG));
        if (bal.USD !== 0) parts.push(fmt.usd(bal.USD));
        hint.textContent = parts.length ? `Saldo: ${parts.join(' · ')}` : '';
        hint.style.color = (bal.BRL < 0 || bal.PYG < 0 || bal.USD < 0) ? 'var(--danger)' : 'var(--success)';
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
        const t    = document.getElementById('type').value;
        const isTr = t === 'TRANSFERENCIA';
        const isIn = t === 'ENTRADA';
        const isOut = t === 'SAIDA';
        const isGF  = t === 'GASTO_FIXO';
        const isGV  = t === 'GASTO_VARIAVEL';

        // Categoria: mostrar para saída, fixo e variável
        const showCat = isOut || isGF || isGV;

        this._sf('transfer-fields',      isTr);
        this._sf('field-origem',         isIn || isTr);
        this._sf('field-categoria',      showCat);
        this._sf('field-parcelas',       isGV);
        this._sf('field-recorrente',     isGF);
        this._sf('field-reserva',        isIn);
        this._sf('field-receita-futura', isIn);
        this._sf('field-due-date',       isGF || isGV);
        this._sf('field-status-pago',    isGF || isGV);

        if (!isIn) {
            document.getElementById('is-reserva').checked = false;
            const rft = document.getElementById('is-receita-futura');
            if (rft) rft.checked = false;
        }

        // Atualiza datalist de carteiras conforme tipo
        UIDatalist.filterForType(t);
        this.onMethodChange();
    },

    onCurrencyChange() {
        this.onMethodChange();
        this._updateRatePreview();
        this._updateWiseUSDDeductField();
    },

    onMethodChange() {
        const method  = document.getElementById('method').value;
        const tipo    = document.getElementById('type').value;
        const currency = document.getElementById('currency').value;
        const currDest = document.getElementById('currency-dest')?.value;
        const isWise  = method === 'Wise';
        const isMG    = method === 'Moneygram';

        // Remessa block: transferência MG ou Wise
        const showRemessa = (isWise || isMG) && tipo === 'TRANSFERENCIA';
        this._sf('remessa-block', showRemessa);
        this._sf('btn-fetch-wise', isWise && showRemessa);

        if (showRemessa) {
            const lbl = document.getElementById('remessa-label');
            // Wise: BRL → USD (não mais BRL → PYG)
            if (isWise) {
                lbl.textContent = '🏦 Wise — BRL → USD (cotação automática)';
                this._sf('field-valor-usd', true);
                this._sf('field-valor-convertido', false);
            } else if (isMG) {
                lbl.textContent = '💸 Moneygram — BRL → ₲ (spread 6,18%)';
                this._sf('field-valor-usd', false);
                this._sf('field-valor-convertido', true);
                this._calcMoneygram();
            }
        } else {
            this._sf('field-valor-usd', false);
            this._sf('field-valor-convertido', true);
        }

        this._updateWiseUSDDeductField();
    },

    // Mostra campo de desconto USD quando: carteira = Wise, moeda = PYG, tipo = saída/gasto
    _updateWiseUSDDeductField() {
        const wallet   = document.getElementById('wallet')?.value?.trim();
        const currency = document.getElementById('currency')?.value;
        const tipo     = document.getElementById('type')?.value;
        const isExpense = ['SAIDA', 'GASTO_FIXO', 'GASTO_VARIAVEL'].includes(tipo);
        const isWiseWallet = Config.USD_WALLETS.some(w => wallet?.toLowerCase().includes(w.toLowerCase()));

        const show = isExpense && currency === 'PYG' && isWiseWallet;
        this._sf('field-wise-usd-deduct', show);

        // Atualiza preview USD deduction
        if (show) {
            const usdAmt = parseFloat(document.getElementById('amount-usd-deducted')?.value) || 0;
            const pygAmt = parseFloat(document.getElementById('amount')?.value) || 0;
            const prev   = document.getElementById('wise-usd-preview');
            if (prev && usdAmt > 0 && pygAmt > 0) {
                prev.style.display = 'block';
                prev.textContent   = `Cotação efetiva: $1 = ₲ ${(pygAmt / usdAmt).toFixed(0)} (Referência: ₲ ${State.usdPygRate.toFixed(0)})`;
            } else if (prev) {
                prev.style.display = 'none';
            }
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
        const resultado = Math.round(v * rate * (1 - Config.MONEYGRAM_SPREAD));
        const taxa      = v * rate * Config.MONEYGRAM_SPREAD;
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
            // Wise agora retorna USD, não PYG
            const res = await fetch(`${Config.SB_URL}/functions/v1/get-wise-quote`, {
                method:  'POST',
                headers: {
                    'Content-Type':  'application/json',
                    'Authorization': `Bearer ${Config.SB_KEY}`,
                },
                body: JSON.stringify({ sourceAmount: v, sourceCurrency: 'BRL', targetCurrency: 'USD' }),
            });

            const data = await res.json();
            if (data.error) throw new Error(data.error);

            const usdEl = document.getElementById('valor-usd');
            const trEl  = document.getElementById('taxa-real');
            if (usdEl) usdEl.value = parseFloat(data.targetAmount).toFixed(2);
            if (trEl)  trEl.value  = (data.fee || 0).toFixed(2);
            this._updateRatePreview();
            UIToast.show(`✅ Wise: $ ${parseFloat(data.targetAmount).toFixed(2)} USD (taxa: R$ ${(data.fee || 0).toFixed(2)})`, 'success', 5000);
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
        const vc = parseFloat(document.getElementById('valor-convertido')?.value);
        const vu = parseFloat(document.getElementById('valor-usd')?.value);
        const v  = parseFloat(document.getElementById('amount').value);
        const el = document.getElementById('rate-preview');
        if (!el) return;
        if (vc > 0 && v > 0) {
            el.style.display = 'block';
            el.textContent   = `Cotação efetiva: R$ 1 = ₲ ${(vc / v).toFixed(0)} (API: ₲ ${State.exchangeRate.toFixed(0)})`;
        } else if (vu > 0 && v > 0) {
            el.style.display = 'block';
            el.textContent   = `Cotação efetiva: R$ 1 = $ ${(vu / v).toFixed(4)} (R$ ${State.usdBrlRate.toFixed(2)}/USD)`;
        } else {
            el.style.display = 'none';
        }
    },

    populate(t) {
        const sv = (id, v) => { const el = document.getElementById(id); if (el) el.value = v ?? ''; };
        sv('tx-id', t.id); sv('type', t.tipo); sv('currency', t.moeda); sv('amount', t.valor);
        sv('tx-date', t.data); sv('wallet', t.local_dinheiro || '');
        sv('method', t.metodo || 'Efectivo'); sv('notes', t.observacoes || '');
        sv('parcela-atual', t.parcela_atual || 1); sv('total-parcelas', t.total_parcelas || 1);
        sv('wallet-dest', t.wallet_dest || ''); sv('currency-dest', t.moeda_dest || 'PYG');
        sv('taxa-real', t.taxa_real || ''); sv('valor-convertido', t.valor_convertido || '');
        sv('valor-usd', t.valor_usd || '');
        sv('amount-usd-deducted', t.currency_deducted || '');
        sv('due-date', t.due_date || '');
        sv('tx-transfer-pair-id', t.transferencia_id || '');

        // Origem dropdown
        const origemSel = document.getElementById('origem-select');
        const origemOutro = document.getElementById('origem-outro');
        if (origemSel) {
            const savedSel = t.origem_select || '';
            const opts = [...origemSel.options].map(o => o.value);
            if (savedSel && opts.includes(savedSel)) {
                origemSel.value = savedSel;
                if (savedSel === 'Outro' && origemOutro) { origemOutro.style.display = ''; origemOutro.value = t.origem_destino || ''; }
            } else if (t.origem_destino) {
                origemSel.value = 'Outro';
                if (origemOutro) { origemOutro.style.display = ''; origemOutro.value = t.origem_destino; }
            }
        }

        // Categoria dropdown
        const catSel  = document.getElementById('categoria');
        const catOutro = document.getElementById('categoria-outro');
        if (catSel) {
            const savedCat = t.categoria_select || t.categoria || '';
            const catOpts  = [...catSel.options].map(o => o.value);
            if (savedCat && catOpts.includes(savedCat)) {
                catSel.value = savedCat;
                if (savedCat === 'Outro' && catOutro) { catOutro.style.display = ''; catOutro.value = t.categoria || ''; }
            } else if (t.categoria) {
                catSel.value = 'Outro';
                if (catOutro) { catOutro.style.display = ''; catOutro.value = t.categoria; }
            }
        }

        document.getElementById('is-reserva').checked  = !!t.is_reserva;
        document.getElementById('conciliado').checked   = !!t.conciliado;
        const isPagoCb = document.getElementById('is-pago');
        if (isPagoCb) isPagoCb.checked = STATUS_PAGO.includes(t.status);
        const rft = document.getElementById('is-receita-futura');
        if (rft) rft.checked = t.status === 'AGUARDANDO';
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

        // Listeners para atualização de preview e hints
        document.getElementById('valor-convertido')?.addEventListener('input', () => Modal._updateRatePreview());
        document.getElementById('valor-usd')?.addEventListener('input', () => Modal._updateRatePreview());
        document.getElementById('amount-usd-deducted')?.addEventListener('input', () => Modal._updateWiseUSDDeductField());
        document.getElementById('wallet')?.addEventListener('input', e => {
            UIDatalist.updateWalletHint(e.target.value);
            Modal._updateWiseUSDDeductField();
        });
        document.getElementById('currency')?.addEventListener('change', () => Modal._updateWiseUSDDeductField());

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

        const origemSel   = document.getElementById('origem-select')?.value  || '';
        const origemOutro = document.getElementById('origem-outro')?.value   || '';
        const origemVal   = origemSel === 'Outro' ? origemOutro : origemSel;

        const catSel   = document.getElementById('categoria')?.value   || '';
        const catOutro = document.getElementById('categoria-outro')?.value || '';
        const catVal   = catSel === 'Outro' ? catOutro : catSel;

        // Para gastos, origem_destino = categoria; para entradas = origem
        const isGastoOD = ['SAIDA','GASTO_FIXO','GASTO_VARIAVEL'].includes(tipo);
        const isGasto   = tipo === 'GASTO_FIXO' || tipo === 'GASTO_VARIAVEL';
        const origemDestino = isGastoOD ? catVal : origemVal;

        const isFutureIncome = document.getElementById('is-receita-futura')?.checked;

        // Status:
        //   Novo GASTO_FIXO/VARIAVEL → sempre PENDENTE
        //   Editando GASTO_FIXO/VARIAVEL → respeita checkbox "Pago"
        //   ENTRADA futura → AGUARDANDO
        //   Demais → CONCLUIDO
        const txId     = document.getElementById('tx-id').value;
        const isPagoCb = document.getElementById('is-pago')?.checked;

        let status;
        if (isFutureIncome) {
            status = 'AGUARDANDO';
        } else if (isGasto) {
            status = (txId && isPagoCb) ? 'PAGO' : 'PENDENTE';
        } else {
            status = 'CONCLUIDO';
        }

        return {
            tipo,
            moeda:            document.getElementById('currency').value,
            valor:            parseFloat(document.getElementById('amount').value),
            origem_destino:   origemDestino,
            local_dinheiro:   document.getElementById('wallet').value,
            metodo:           document.getElementById('method').value,
            observacoes:      document.getElementById('notes').value || null,
            status,
            data:             document.getElementById('tx-date').value,
            due_date:         document.getElementById('due-date')?.value || null,
            categoria:        catVal || null,
            parcela_atual:    parseInt(document.getElementById('parcela-atual').value) || 1,
            total_parcelas:   parseInt(document.getElementById('total-parcelas').value) || 1,
            is_reserva:       document.getElementById('is-reserva').checked,
            conciliado:       document.getElementById('conciliado').checked,
            taxa_cambio_dia:  State.exchangeRate,
            taxa_real:        parseFloat(document.getElementById('taxa-real').value) || null,
            valor_convertido: parseFloat(document.getElementById('valor-convertido').value) || null,
            valor_usd:        parseFloat(document.getElementById('valor-usd')?.value) || null,
            currency_deducted: parseFloat(document.getElementById('amount-usd-deducted')?.value) || null,
        };
    },

    async _saveInstallments(base) {
        if (base.total_parcelas <= 1) return await DB.insert(base);
        const [y, m, d] = base.data.split('-').map(Number);
        return await DB.insertMany(Array.from({ length: base.total_parcelas }, (_, i) => {
            const mi = (m - 1 + i) % 12, yi = Math.floor((m - 1 + i) / 12);
            return {
                ...base,
                parcela_atual: i + 1,
                data: `${y + yi}-${String(mi + 1).padStart(2,'0')}-${String(d).padStart(2,'0')}`,
                status: 'PENDENTE', // todas as parcelas nascem PENDENTE
            };
        }));
    },

    async _saveTransfer(base) {
        const pid    = crypto.randomUUID();
        const wDest  = document.getElementById('wallet-dest').value;
        const mDest  = document.getElementById('currency-dest').value;
        const method = document.getElementById('method').value;
        const isWise = method === 'Wise';
        const isMG   = method === 'Moneygram';

        let valorDest, mDestFinal;

        if (isWise) {
            // Wise: BRL → USD
            const usdVal = parseFloat(document.getElementById('valor-usd')?.value);
            valorDest    = usdVal > 0 ? usdVal : base.valor / State.usdBrlRate;
            mDestFinal   = 'USD';
        } else if (isMG) {
            // Moneygram: BRL → PYG
            const vcVal = parseFloat(document.getElementById('valor-convertido').value);
            valorDest   = vcVal > 0 ? vcVal : Math.round(base.valor * State.exchangeRate * (1 - Config.MONEYGRAM_SPREAD));
            mDestFinal  = 'PYG';
        } else {
            valorDest  = parseFloat(document.getElementById('valor-convertido').value) || base.valor;
            mDestFinal = mDest;
        }

        return await DB.insertMany([
            // Saída da carteira origem
            { ...base, tipo: 'TRANSFERENCIA', status: 'CONCLUIDO', transferencia_id: pid, wallet_dest: wDest, moeda_dest: mDestFinal },
            // Entrada na carteira destino
            {
                tipo: 'TRANSFERENCIA', moeda: mDestFinal, valor: valorDest,
                origem_destino: `De: ${base.local_dinheiro}`, local_dinheiro: wDest,
                metodo: base.metodo, observacoes: base.observacoes, status: 'CONCLUIDO',
                data: base.data, transferencia_id: pid, taxa_cambio_dia: base.taxa_cambio_dia,
                taxa_real: base.taxa_real, valor_convertido: valorDest,
                valor_usd: isWise ? valorDest : null,
                is_reserva: false, conciliado: false, parcela_atual: 1, total_parcelas: 1,
            },
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

        const [allData, pendingDebts, futureIncome] = await Promise.all([
            DB.fetchMonth(year, month),
            DB.fetchPendingDebts(year, String(month).padStart(2, '0')),
            DB.fetchFutureIncome(),
        ]);

        State.transactions = allData.filter(t => t.status !== 'AGUARDANDO');
        State.debts        = pendingDebts;
        State.futureIncome = futureIncome;

        // Badge chip "Aguardando"
        const chip = document.querySelector('[data-filter="RECEITA_FUTURA"]');
        if (chip) chip.innerHTML = futureIncome.length > 0
            ? `📅 Aguardando <span class="chip-badge">${futureIncome.length}</span>`
            : `📅 Aguardando`;

        // Badge chip "Dívidas"
        const debtChip = document.querySelector('.chip[onclick*="DIVIDA"]');
        const totalDebts = State.debts.length +
            State.transactions.filter(t => (t.tipo === 'GASTO_FIXO' || t.tipo === 'GASTO_VARIAVEL') && t.status === 'PENDENTE').length;
        if (debtChip) debtChip.innerHTML = totalDebts > 0
            ? `⏳ Dívidas <span class="chip-badge">${totalDebts}</span>`
            : `⏳ Dívidas`;

        UITotals.update(State.transactions);
        UIDatalist.update(State.transactions);
        this._applyListFilter();

        if (document.getElementById('view-dashboard').classList.contains('active-view')) {
            UIDashboard.update(State.transactions);
        }
    },

    _applyListFilter() {
        if (State.currentFilter === 'RECEITA_FUTURA') { UIList.renderFutureOnly(); return; }
        if (State.currentFilter === 'DIVIDA')          { UIList.renderDebtsOnly();  return; }

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
    editTx(id)             {
        const t = State.transactions.find(x => x.id === id)
               || State.debts.find(x => x.id === id)
               || State.futureIncome.find(x => x.id === id);
        if (t) Modal.populate(t);
    },
    onTypeChange()         { Modal.onTypeChange(); },
    onCurrencyChange()     { Modal.onCurrencyChange(); },
    onParcelasChange()     { Modal.onParcelasChange(); },
    onMethodChange()       { Modal.onMethodChange(); },
    onOrigemChange()       { Modal.onOrigemChange(); },
    onCategoriaChange()    { Modal.onCategoriaChange(); },
    onValorConvertidoChange() { Modal._updateRatePreview(); },
    onValorUSDChange()     { Modal._updateRatePreview(); },
    onWalletSelectChange() {
        const sel = document.getElementById('wallet-select');
        const inp = document.getElementById('wallet');
        if (sel && inp && sel.value) inp.value = sel.value;
        UIDatalist.updateWalletHint(inp?.value);
        Modal._updateWiseUSDDeductField();
    },
    fetchWiseQuote()       { return Modal.fetchWiseQuote(); },

    // Marca um gasto como PAGO, registra data efetiva e atualiza saldo
    async markAsPaid(id) {
        const today = new Date().toISOString().split('T')[0];
        const err   = await DB.update(id, { status: 'PAGO', paid_at: today });
        if (err) { UIToast.show('Erro: ' + err.message, 'danger'); return; }
        UIToast.show('✅ Marcado como pago! Saldo atualizado.', 'success');
        if (State.isOnline) this.fetchData();
    },

    async confirmFutureIncome(id) {
        const today = new Date().toISOString().split('T')[0];
        const err   = await DB.update(id, { status: 'CONCLUIDO', paid_at: today, data: today });
        if (err) { UIToast.show('Erro: ' + err.message, 'danger'); return; }
        UIToast.show('✅ Receita confirmada e lançada!', 'success');
        if (State.isOnline) this.fetchData();
    },

    postponeFutureIncome(id) {
        const t = State.futureIncome.find(x => x.id === id);
        if (!t) return;
        UIToast.show('📅 Mude a data para adiar e salve', 'info', 4000);
        Modal.populate(t);
    },

    async cancelFutureIncome(id) {
        if (!confirm('Cancelar esta receita esperada?')) return;
        const err = await DB.update(id, { status: 'CANCELADO' });
        if (err) { UIToast.show('Erro: ' + err.message, 'danger'); return; }
        UIToast.show('❌ Receita cancelada', 'warning');
        if (State.isOnline) this.fetchData();
    },

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

// Spin animation
const _style = document.createElement('style');
_style.textContent = `@keyframes spin{to{transform:rotate(360deg)}} .spin{animation:spin 0.8s linear infinite;display:inline-block}`;
document.head.appendChild(_style);


// ============================================================
// PWA INSTALL BANNER
// ============================================================
const PWAInstall = {
    _deferredPrompt: null,
    _isIOS: /iphone|ipad|ipod/i.test(navigator.userAgent),
    _DISMISSED_KEY: 'pwa_install_dismissed',

    init() {
        if (window.matchMedia('(display-mode: standalone)').matches) return;
        const ts = parseInt(localStorage.getItem(this._DISMISSED_KEY) || '0');
        if (Date.now() - ts < 7 * 24 * 60 * 60 * 1000) return;

        if (this._isIOS) {
            setTimeout(() => this._showBanner('Toque em compartilhar → "Tela de Início"'), 2500);
        } else {
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
        document.body.style.paddingBottom = (banner.offsetHeight + 8) + 'px';
    },

    _hideBanner() {
        const banner = document.getElementById('install-banner');
        if (banner) {
            banner.style.transition = 'transform 0.25s ease, opacity 0.25s ease';
            banner.style.transform  = 'translateY(100%)';
            banner.style.opacity    = '0';
            setTimeout(() => { banner.style.display = 'none'; }, 260);
        }
        document.body.style.paddingBottom = '';
    },

    dismiss() { localStorage.setItem(this._DISMISSED_KEY, String(Date.now())); this._hideBanner(); },

    async install() {
        if (this._isIOS) { this._hideBanner(); this._showIOSModal(); return; }
        if (!this._deferredPrompt) return;
        this._deferredPrompt.prompt();
        const { outcome } = await this._deferredPrompt.userChoice;
        this._deferredPrompt = null;
        if (outcome === 'accepted') UIToast.show('✅ App instalado com sucesso!', 'success', 4000);
        this._hideBanner();
    },

    _showIOSModal() {
        const modal = document.createElement('div');
        modal.className = 'ios-install-modal';
        modal.innerHTML = `
            <div class="ios-install-modal__box">
                <h3>📲 Instalar no iPhone</h3>
                <ul class="ios-install-modal__steps">
                    <li><span class="step-num">1</span><span>Toque no botão de compartilhar <strong style="color:#a5b4fc;">⎋</strong> na barra do Safari</span></li>
                    <li><span class="step-num">2</span><span>Role e toque em <strong style="color:#a5b4fc;">"Adicionar à Tela de Início"</strong></span></li>
                    <li><span class="step-num">3</span><span>Toque em <strong style="color:#a5b4fc;">"Adicionar"</strong> no canto superior direito</span></li>
                </ul>
                <button class="ios-install-modal__close" onclick="this.closest('.ios-install-modal').remove()">Entendi</button>
            </div>`;
        document.body.appendChild(modal);
        modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
    },
};


// ============================================================
// PRINT REPORT
// ============================================================
const PrintReport = {

    print() {
        const isDash = document.getElementById('view-dashboard').classList.contains('active-view');
        isDash ? this._printDashboard() : this._printLista();
    },

    _printLista() {
        const filter = State.currentFilter;
        let txs = filter === 'TUDO' ? State.transactions
                : filter === 'DIVIDA' ? [...State.debts, ...State.transactions.filter(t => (t.tipo === 'GASTO_FIXO' || t.tipo === 'GASTO_VARIAVEL') && t.status === 'PENDENTE')]
                : filter === 'RECEITA_FUTURA' ? State.futureIncome
                : State.transactions.filter(t => t.tipo === filter);

        const TLBL = { TUDO:'Todas', ENTRADA:'Entradas', SAIDA:'Saídas', GASTO_FIXO:'G. Fixos',
                       GASTO_VARIAVEL:'G. Variáveis', DIVIDA:'Dívidas', TRANSFERENCIA:'Transferências',
                       RECEITA_FUTURA:'Aguardando' };
        const filterLabel = TLBL[filter] || filter;

        const ent  = Calc.pl(txs, { tipo: 'ENTRADA', convertAll: true });
        const sai  = Math.abs(Calc.pl(txs, { tipo: 'SAIDA', convertAll: true }));
        const res  = ent - sai;
        const brlD = Calc.balance(txs, 'BRL', { onlyAvailable: true });
        const pygD = Calc.balance(txs, 'PYG', { onlyAvailable: true });
        const sign = (v, fn) => (v < 0 ? '−' : '') + fn(Math.abs(v));

        const gastoTxs = txs.filter(t => TIPOS_GASTO.includes(t.tipo));
        const chartMap = {};
        gastoTxs.forEach(t => {
            const k = t.categoria || t.origem_destino || 'Outros';
            chartMap[k] = (chartMap[k] || 0) + (t.moeda === 'BRL' ? t.valor * Calc.txRate(t) : t.valor);
        });

        const rows  = this._buildRows(txs);
        const month = document.getElementById('filter-month').value;
        this._openWindow({ label: this._monthLabel(month), filterLabel, ent, sai, res, brlD, pygD, sign,
                           rows, chartMap, chartTitle: `Distribuição — ${filterLabel}` });
    },

    _printDashboard() {
        const origin = State.dashOrigin, moeda = State.dashMoeda, tipo = State.dashType;
        let txs = State.transactions;
        if (origin !== 'TUDO') txs = txs.filter(t => t.origem_destino === origin);
        if (moeda !== 'MIX')   txs = txs.filter(t => t.moeda === moeda);
        if (tipo  !== 'TUDO')  txs = txs.filter(t => t.tipo === tipo);

        const MLBL  = { BRL:'R$', PYG:'₲', MIX:'Todas as moedas' };
        const TLBL2 = { TUDO:'Tudo', ENTRADA:'Entradas', SAIDA:'Saídas', GASTO_FIXO:'G. Fixos', GASTO_VARIAVEL:'G. Variáveis', DIVIDA:'Dívidas' };
        const filterLabel = [origin !== 'TUDO' ? `Origem: ${origin}` : null, `Moeda: ${MLBL[moeda]||moeda}`, `Tipo: ${TLBL2[tipo]||tipo}`].filter(Boolean).join('  ·  ');

        const ent  = Calc.pl(txs, { tipo: 'ENTRADA', convertAll: true });
        const sai  = Math.abs(Calc.pl(txs, { tipo: 'SAIDA', convertAll: true }));
        const res  = ent - sai;
        const brlD = Calc.balance(State.transactions, 'BRL', { onlyAvailable: true });
        const pygD = Calc.balance(State.transactions, 'PYG', { onlyAvailable: true });
        const sign = (v, fn) => (v < 0 ? '−' : '') + fn(Math.abs(v));

        const gFn = tipo === 'ENTRADA' ? t => t.origem_destino || 'Outros' : t => t.categoria || t.origem_destino || 'Outros';
        const chartMap = {};
        txs.filter(t => t.tipo !== 'TRANSFERENCIA').forEach(t => {
            const k = gFn(t);
            chartMap[k] = (chartMap[k]||0) + (moeda === 'MIX' && t.moeda === 'BRL' ? t.valor * Calc.txRate(t) : t.valor);
        });

        const rows = this._buildRows(txs);
        const month = document.getElementById('filter-month').value;
        this._openWindow({ label: this._monthLabel(month), filterLabel, ent, sai, res, brlD, pygD, sign,
                           rows, chartMap, chartTitle: document.getElementById('chartOriginsTitle')?.textContent || 'Distribuição' });
    },

    _monthLabel(month) {
        if (!month) return '';
        const [y, m] = month.split('-');
        const MONTHS = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
        return `${MONTHS[parseInt(m)-1]} / ${y}`;
    },

    _buildRows(txs) {
        const TLBL = { ENTRADA:'Entrada', SAIDA:'Saída', GASTO_FIXO:'G.Fixo', GASTO_VARIAVEL:'G.Variável',
                       DIVIDA:'Dívida', TRANSFERENCIA:'Transf.' };
        return [...txs].sort((a, b) => a.data < b.data ? -1 : 1).map(t => {
            const isIn = t.tipo === 'ENTRADA', isTr = t.tipo === 'TRANSFERENCIA';
            const c = isIn ? '#15803d' : isTr ? '#6366f1' : t.tipo === 'DIVIDA' ? '#b45309' : '#dc2626';
            const s = isIn ? '+' : isTr ? '⇄' : '−';
            const parcela = t.total_parcelas > 1 ? `<span style="font-size:8px;color:#6366f1;font-weight:700;margin-left:4px;">${t.parcela_atual}/${t.total_parcelas}</span>` : '';
            const status = t.status === 'PENDENTE' ? `<span style="font-size:8px;background:#fef9c3;color:#854d0e;padding:1px 4px;border-radius:3px;margin-left:4px;">⏳ Pendente</span>` : '';
            const usdLine = t.currency_deducted ? `<span style="font-size:8px;color:#7c3aed;margin-left:4px;">−$${parseFloat(t.currency_deducted).toFixed(2)}</span>` : '';
            return `<tr>
                <td>${fmt.date(t.data)}</td>
                <td style="color:${c};font-weight:700">${TLBL[t.tipo]||t.tipo}</td>
                <td>${t.origem_destino||'—'}${parcela}${status}</td>
                <td>${t.categoria||'—'}</td>
                <td>${t.local_dinheiro||'—'}${usdLine}</td>
                <td>${t.metodo||'—'}</td>
                <td style="text-align:right;font-weight:600;color:${c}">${s} ${fmt.money(t.valor,t.moeda)}</td>
                <td style="text-align:center">${t.conciliado ? '✓' : t.status === 'PENDENTE' ? '⏳' : ''}</td>
            </tr>`;
        }).join('');
    },

    _openWindow({ label, filterLabel, ent, sai, res, brlD, pygD, sign, rows, chartMap, chartTitle }) {
        const taxa = State.exchangeRate, COLORS = Config.CHART_COLORS;
        const cLabels = Object.keys(chartMap), cData = Object.values(chartMap);
        const total   = cData.reduce((a, b) => a + b, 0);
        const comp    = Calc.totalComprometido(State.transactions, State.debts);

        const legendHTML = cLabels.map((l, i) => {
            const v = cData[i], c = COLORS[i % COLORS.length];
            const pct = total > 0 ? ((v/total)*100).toFixed(1) : '0';
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
<title>Relatório — ${label}</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"><\/script>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Segoe UI',Arial,sans-serif;font-size:11px;color:#1e1b4b;padding:16px}
.hdr{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #4f46e5;padding-bottom:10px;margin-bottom:14px}
.hdr-title{font-size:18px;font-weight:800;color:#4f46e5}
.cards{display:grid;grid-template-columns:repeat(6,1fr);gap:6px;margin-bottom:14px}
.card{border:1.5px solid #e0e7ff;border-radius:8px;padding:7px 9px}
.card h4{font-size:7px;text-transform:uppercase;letter-spacing:.06em;color:#94a3b8;margin-bottom:3px}
.card strong{font-size:11px;font-weight:800;display:block}
.green strong{color:#15803d}.red strong{color:#dc2626}.blue strong{color:#1d4ed8}
.purple strong{color:#4f46e5}.amber strong{color:#b45309}.orange strong{color:#ea580c}
.section-title{font-size:11px;font-weight:700;color:#4f46e5;margin:12px 0 6px;padding-bottom:3px;border-bottom:1.5px solid #e0e7ff}
.chart-section{display:grid;grid-template-columns:180px 1fr;gap:16px;margin-bottom:14px;align-items:start}
.chart-wrap{position:relative;width:180px;height:180px}
table{width:100%;border-collapse:collapse;font-size:10px}
thead tr{background:#4f46e5;color:#fff}
thead th{padding:5px 6px;text-align:left;font-weight:600;font-size:8.5px}
tbody tr{border-bottom:1px solid #f1f5f9}
tbody tr:nth-child(even){background:#f8fafc}
td{padding:4px 6px;vertical-align:middle}
.footer{margin-top:12px;padding-top:7px;border-top:1px solid #e0e7ff;font-size:8px;color:#94a3b8;display:flex;justify-content:space-between}
@media print{@page{margin:10mm 8mm;size:A4 portrait}body{padding:0}.chart-section{break-inside:avoid}}
</style></head><body>

<div class="hdr">
  <div>
    <div class="hdr-title">💰 Finanças Família Morais</div>
    <div style="font-size:12px;color:#6366f1;font-weight:600;margin-top:2px;">${label}</div>
    <span style="font-size:9px;color:#fff;background:#6366f1;padding:2px 8px;border-radius:10px;margin-top:4px;display:inline-block;">Filtro: ${filterLabel}</span>
  </div>
  <div style="font-size:9px;color:#94a3b8;text-align:right">
    Gerado em ${new Date().toLocaleString('pt-BR')}<br>
    Câmbio: R$1 = ₲ ${taxa.toFixed(0)} · $1 = R$ ${State.usdBrlRate.toFixed(2)}
  </div>
</div>

<div class="cards">
  <div class="card green"><h4>Receitas</h4><strong>${fmt.pyg(ent)}</strong></div>
  <div class="card red"><h4>Despesas</h4><strong>${fmt.pyg(sai)}</strong></div>
  <div class="card ${res >= 0 ? 'blue' : 'red'}"><h4>Resultado</h4><strong>${sign(res,fmt.pyg)}</strong></div>
  <div class="card purple"><h4>Saldo R$</h4><strong>${sign(brlD,fmt.brl)}</strong></div>
  <div class="card amber"><h4>Saldo ₲</h4><strong>${sign(pygD,fmt.pyg)}</strong></div>
  <div class="card orange"><h4>⚡ Comprometido</h4><strong>${fmt.pyg(comp.total)}</strong></div>
</div>

${cLabels.length > 0 ? `
<div class="section-title">📊 ${chartTitle}</div>
<div class="chart-section">
  <div class="chart-wrap"><canvas id="printChart" width="180" height="180"></canvas></div>
  <div>${legendHTML}</div>
</div>` : ''}

<div class="section-title">📋 Movimentações (${rows.split('<tr>').length - 1} registros)</div>
<table>
  <thead>
    <tr><th>Data</th><th>Tipo</th><th>Origem/Destino</th><th>Categoria</th><th>Carteira</th><th>Método</th><th style="text-align:right">Valor</th><th>St.</th></tr>
  </thead>
  <tbody>${rows}</tbody>
</table>

<div class="footer">
  <span>Finanças Família Morais · ${label} · ${filterLabel}</span>
  <span>₲ ${taxa.toFixed(0)}/R$ · $1 = R$ ${State.usdBrlRate.toFixed(2)}</span>
</div>

<script>
window.onload = function() {
  ${cLabels.length > 0 ? `
  var ctx = document.getElementById('printChart').getContext('2d');
  new Chart(ctx, {
    type: 'doughnut',
    data: { labels: ${JSON.stringify(cLabels)}, datasets: [{ data: ${JSON.stringify(cData)}, backgroundColor: ${JSON.stringify(COLORS.slice(0,cLabels.length))}, borderWidth:2, borderColor:'#fff', hoverOffset:0 }] },
    options: { responsive:false, cutout:'58%', animation:{ onComplete: function(){ window.print(); } }, plugins:{ legend:{display:false}, tooltip:{enabled:false} } }
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
