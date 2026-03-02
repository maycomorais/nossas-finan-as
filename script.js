const SB_URL = "https://alpyltplxrhrwxygkkar.supabase.co";
const SB_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFscHlsdHBseHJocnd4eWdra2FyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI0Njg5NDUsImV4cCI6MjA4ODA0NDk0NX0.QjM7L6sxNB4-LN3_x-ijo3MoZrpgzgkO8E79UUD2vUk";

const _supabase = supabase.createClient(SB_URL, SB_KEY);

const app = {
    currentFilter: 'TUDO',
    currentDashMoeda: 'BRL',
    currentDashType: 'SAIDA', 
    transactionsData: [],
    charts: {}, 
    exchangeRate: null,

    async init() {
        this.setDefaultDate();
        await this.fetchExchangeRate(); 
        await this.fetchData();
        this.setupForm();
    },

    async fetchExchangeRate() {
        try {
            const fallbackRes = await fetch('https://open.er-api.com/v6/latest/BRL');
            const data = await fallbackRes.json();
            this.exchangeRate = data.rates.PYG * 0.98; 
        } catch (err) {
            console.error("Erro ao buscar câmbio:", err);
            this.exchangeRate = 1420; 
        }
    },

    setDefaultDate() {
        const now = new Date();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const input = document.getElementById('filter-month');
        input.value = `${now.getFullYear()}-${month}`;
        input.onchange = () => this.fetchData();
    },

    async fetchData() {
        const monthVal = document.getElementById('filter-month').value;
        if (!monthVal) return;
        
        const [year, month] = monthVal.split('-');
        const start = `${year}-${month}-01`;
        const end = `${year}-${month}-31`;

        const { data, error } = await _supabase.from('transacoes')
            .select('*')
            .gte('data', start)
            .lte('data', end)
            .order('data', { ascending: false });

        if (!error) {
            this.transactionsData = data || []; 
            this.updateTotals(this.transactionsData);
            this.updateDatalists(this.transactionsData);
            
            this.applyListFilter();
            
            if(document.getElementById('view-dashboard').classList.contains('active-view')) {
                this.renderDashboard();
            }
        } else {
            console.error("Erro ao buscar dados:", error);
        }
    },

    applyListFilter() {
        let filtered = this.transactionsData;
        if (this.currentFilter !== 'TUDO') {
            filtered = this.transactionsData.filter(t => t.tipo === this.currentFilter);
        }
        this.renderGrouped(filtered);
    },

    updateTotals(data) {
        const validos = data.filter(t => t.tipo !== 'DIVIDA' || t.status === 'PAGA');
        
        const brlPuro = validos.filter(t => t.moeda === 'BRL').reduce((acc, t) => acc + (t.tipo === 'ENTRADA' ? t.valor : -t.valor), 0);
        const pygPuro = validos.filter(t => t.moeda === 'PYG').reduce((acc, t) => acc + (t.tipo === 'ENTRADA' ? t.valor : -t.valor), 0);
        
        const taxa = this.exchangeRate || 1420;
        const brlConvertidoEmPyg = brlPuro * taxa;
        
        const saldoTotalGuarani = pygPuro + brlConvertidoEmPyg;

        document.getElementById('balance-brl').innerText = `R$ ${brlPuro.toLocaleString('pt-BR', {minimumFractionDigits: 2})}`;
        
        const brlSubInfo = document.getElementById('brl-in-pyg');
        if (brlPuro === 0) {
            brlSubInfo.style.display = 'none';
        } else {
            brlSubInfo.style.display = 'block';
            brlSubInfo.innerText = `≈ ₲ ${brlConvertidoEmPyg.toLocaleString('es-PY', {maximumFractionDigits: 0})}`;
        }
        
        document.getElementById('balance-pyg').innerText = `₲ ${saldoTotalGuarani.toLocaleString('es-PY', {maximumFractionDigits: 0})}`;
        document.getElementById('cambio-dia-texto').innerText = `Câmbio: R$ 1 = ₲ ${taxa.toFixed(0)}`;
    },

    updateDatalists(data) {
        const origins = [...new Set(data.map(t => t.origem_destino))];
        const wallets = [...new Set(data.map(t => t.local_dinheiro))];
        document.getElementById('list-origins').innerHTML = origins.map(o => `<option value="${o}">`).join('');
        document.getElementById('list-wallets').innerHTML = wallets.map(w => `<option value="${w}">`).join('');
    },

    async setupForm() {
        document.getElementById('finance-form').onsubmit = async (e) => {
            e.preventDefault();
            const btn = e.target.querySelector('.btn-submit');
            btn.disabled = true;
            btn.innerText = "Salvando...";

            let imageUrl = null;
            const file = document.getElementById('file-input').files[0];
            const txId = document.getElementById('tx-id').value;

            if (file) {
                const fileExt = file.name.split('.').pop();
                const fileName = `${Math.random()}.${fileExt}`;
                const { data } = await _supabase.storage.from('comprovantes').upload(fileName, file);
                if (data) {
                    const { data: urlData } = _supabase.storage.from('comprovantes').getPublicUrl(fileName);
                    imageUrl = urlData.publicUrl;
                }
            }

            const payload = {
                tipo: document.getElementById('type').value,
                moeda: document.getElementById('currency').value,
                valor: parseFloat(document.getElementById('amount').value),
                origem_destino: document.getElementById('origin').value,
                local_dinheiro: document.getElementById('wallet').value,
                metodo: document.getElementById('method').value,
                observacoes: document.getElementById('notes').value,
                status: document.getElementById('status').value || 'CONCLUIDO',
                data: document.getElementById('tx-date').value
            };

            if (imageUrl) payload.comprovante_url = imageUrl;

            let error;
            if (txId) {
                const res = await _supabase.from('transacoes').update(payload).eq('id', txId);
                error = res.error;
            } else {
                const res = await _supabase.from('transacoes').insert([payload]);
                error = res.error;
            }
            
            if (!error) {
                this.closeModal();
                this.fetchData();
            } else {
                alert("Erro ao salvar: " + error.message);
            }
            btn.disabled = false;
            btn.innerText = "Salvar";
        };
    },

    async deleteTx() {
        const txId = document.getElementById('tx-id').value;
        if (!txId) return;

        if(confirm("Tem certeza que deseja excluir este registro definitivamente?")) {
            const { error } = await _supabase.from('transacoes').delete().eq('id', txId);
            if(!error) {
                this.closeModal();
                this.fetchData();
            } else {
                alert("Erro ao excluir: " + error.message);
            }
        }
    },

    /* ======== RENDERIZAÇÃO DA LISTA EM ACCORDION ======== */
    renderGrouped(data) {
        const list = document.getElementById('transaction-list');
        if (data.length === 0) {
            list.innerHTML = `<div style="text-align:center; padding: 20px; color: #94a3b8;">Nenhuma movimentação no período.</div>`;
            return;
        }

        // Agrupando por Origem
        const groups = {};
        data.forEach(t => {
            const key = t.origem_destino;
            if (!groups[key]) groups[key] = { items: [], brl: 0, pyg: 0 };
            groups[key].items.push(t);
            
            // Lógica do Saldo do Cabeçalho
            if (this.currentFilter === 'TUDO') {
                // Se for "Tudo", mostramos o saldo LÍQUIDO daquela origem
                let val = t.valor;
                if (t.tipo === 'SAIDA') val = -t.valor;
                if (t.tipo === 'DIVIDA') val = 0; // Ignora dívidas pendentes no líquido para não confundir
                
                if (t.moeda === 'BRL') groups[key].brl += val;
                if (t.moeda === 'PYG') groups[key].pyg += val;
            } else {
                // Se filtrou um tipo específico, apenas soma o valor absoluto do que está vendo
                if (t.moeda === 'BRL') groups[key].brl += t.valor;
                if (t.moeda === 'PYG') groups[key].pyg += t.valor;
            }
        });

        // Desenhando o HTML Sanfona
        list.innerHTML = Object.keys(groups).map((origem, index) => {
            const g = groups[origem];
            
            // Formata os totais do cabeçalho
            let totalStr = [];
            if (g.brl !== 0) totalStr.push(`<span class="${g.brl > 0 && this.currentFilter==='TUDO' ? 'text-success' : g.brl < 0 ? 'text-danger' : ''}">R$ ${Math.abs(g.brl).toLocaleString('pt-BR', {minimumFractionDigits:2})}</span>`);
            if (g.pyg !== 0) totalStr.push(`<span class="${g.pyg > 0 && this.currentFilter==='TUDO' ? 'text-success' : g.pyg < 0 ? 'text-danger' : ''}">₲ ${Math.abs(g.pyg).toLocaleString('es-PY')}</span>`);
            if (totalStr.length === 0) totalStr.push('0');

            // Formata os itens internos
            const itemsHtml = g.items.map(t => {
                const isEntrada = t.tipo === 'ENTRADA';
                const isSaida = t.tipo === 'SAIDA';
                return `
                <div class="tx-item">
                    <div class="card-info">
                        <div style="display:flex; align-items:center; gap:6px;">
                            <span style="font-size:0.9rem; font-weight:bold; color: ${isEntrada ? 'var(--success)' : (isSaida ? 'var(--danger)' : '#eab308')}">${isEntrada ? '↑' : (isSaida ? '↓' : '⏳')}</span>
                            <h4 style="font-size:0.85rem; margin:0;">${t.local_dinheiro} • ${t.metodo}</h4>
                            ${t.comprovante_url ? `<span class="material-symbols-rounded has-photo" onclick="window.open('${t.comprovante_url}')" style="font-size:16px;">image</span>` : ''}
                        </div>
                        ${t.observacoes ? `<p style="font-size:0.7rem; font-style:italic; margin-top:2px; color: #94a3b8;">"${t.observacoes}"</p>` : ''}
                        ${t.tipo === 'DIVIDA' ? `<span class="status-badge status-${t.status || 'PENDENTE'}" style="font-size:0.55rem; padding:2px 4px;">${t.status || 'PENDENTE'}</span>` : ''}
                    </div>
                    <div class="card-value">
                        <div class="val ${isEntrada ? 'plus' : ''}" style="font-size:0.85rem;">
                            ${t.moeda === 'BRL' ? 'R$ ' : '₲ '}${t.valor.toLocaleString(t.moeda === 'BRL' ? 'pt-BR' : 'es-PY')}
                        </div>
                        <div class="date" style="font-size:0.65rem;">${t.data.split('-').reverse().join('/')}</div>
                    </div>
                    <button class="btn-edit-icon" onclick="app.editTx('${t.id}')">
                        <span class="material-symbols-rounded" style="font-size:18px;">edit</span>
                    </button>
                </div>
            `}).join('');

            return `
                <div class="group-card">
                    <div class="group-header" onclick="app.toggleGroup(${index})">
                        <div class="group-title">
                            <span class="material-symbols-rounded" id="icon-group-${index}" style="color:#64748b; transition:0.3s;">expand_more</span>
                            ${origem}
                        </div>
                        <div class="group-total">
                            ${totalStr.join('<br>')}
                        </div>
                    </div>
                    <div class="group-body" id="body-group-${index}">
                        ${itemsHtml}
                    </div>
                </div>
            `;
        }).join('');
    },

    toggleGroup(idx) {
        const body = document.getElementById(`body-group-${idx}`);
        const icon = document.getElementById(`icon-group-${idx}`);
        if (body.classList.contains('expanded')) {
            body.classList.remove('expanded');
            icon.style.transform = 'rotate(0deg)';
        } else {
            body.classList.add('expanded');
            icon.style.transform = 'rotate(180deg)';
        }
    },

    switchTab(tab, btnElement) {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        btnElement.classList.add('active');

        if (tab === 'lista') {
            document.getElementById('view-lista').classList.remove('hidden-view');
            document.getElementById('view-lista').classList.add('active-view');
            document.getElementById('view-dashboard').classList.add('hidden-view');
            document.getElementById('view-dashboard').classList.remove('active-view');
        } else {
            document.getElementById('view-lista').classList.add('hidden-view');
            document.getElementById('view-lista').classList.remove('active-view');
            document.getElementById('view-dashboard').classList.remove('hidden-view');
            document.getElementById('view-dashboard').classList.add('active-view');
            this.renderDashboard(); 
        }
    },

    filterType(type, btnElement) {
        this.currentFilter = type;
        document.querySelectorAll('.filter-bar .chip').forEach(c => c.classList.remove('active'));
        btnElement.classList.add('active');
        this.applyListFilter();
    },

    toggleStatus() {
        const tipo = document.getElementById('type').value;
        const statusEl = document.getElementById('status');
        if (tipo === 'DIVIDA') {
            statusEl.classList.remove('hidden');
        } else {
            statusEl.classList.add('hidden');
            statusEl.value = 'CONCLUIDO';
        }
    },

    openModal(defaultType = 'SAIDA') {
        document.getElementById('finance-form').reset();
        document.getElementById('tx-id').value = '';
        document.getElementById('type').value = defaultType;
        document.getElementById('btn-delete').classList.add('hidden');
        document.querySelector('.modal-header h2').innerText = "Novo Registro";
        
        document.getElementById('tx-date').value = new Date().toISOString().split('T')[0];

        this.toggleStatus();

        document.getElementById('modal').classList.remove('hidden');
        setTimeout(() => document.getElementById('modal-content').classList.add('active'), 50);
    },

    editTx(id) {
        const t = this.transactionsData.find(x => x.id === id);
        if(!t) return;

        document.getElementById('tx-id').value = t.id;
        document.getElementById('type').value = t.tipo;
        document.getElementById('currency').value = t.moeda;
        document.getElementById('amount').value = t.valor;
        document.getElementById('tx-date').value = t.data; 
        document.getElementById('origin').value = t.origem_destino;
        document.getElementById('wallet').value = t.local_dinheiro;
        document.getElementById('method').value = t.metodo;
        document.getElementById('notes').value = t.observacoes || '';
        document.getElementById('status').value = t.status || 'PENDENTE';

        this.toggleStatus();

        document.getElementById('btn-delete').classList.remove('hidden');
        document.querySelector('.modal-header h2').innerText = "Editar Registro";

        document.getElementById('modal').classList.remove('hidden');
        setTimeout(() => document.getElementById('modal-content').classList.add('active'), 50);
    },

    closeModal() {
        document.getElementById('modal-content').classList.remove('active');
        setTimeout(() => document.getElementById('modal').classList.add('hidden'), 300);
    },

    setDashMoeda(moeda) {
        this.currentDashMoeda = moeda;
        this.renderDashboard();
    },

    setDashType(type) {
        this.currentDashType = type;
        this.renderDashboard();
    },

    /* ======== DASHBOARD (PIZZA + LEGENDA HTML) ======== */
    renderDashboard() {
        const moedaAtiva = this.currentDashMoeda;
        const tipoAtivo = this.currentDashType;
        const taxa = this.exchangeRate || 1420;

        document.getElementById('dash-btn-brl').classList.toggle('active', moedaAtiva === 'BRL');
        document.getElementById('dash-btn-pyg').classList.toggle('active', moedaAtiva === 'PYG');
        document.getElementById('dash-btn-tudo').classList.toggle('active', tipoAtivo === 'TUDO');
        document.getElementById('dash-btn-entrada').classList.toggle('active', tipoAtivo === 'ENTRADA');
        document.getElementById('dash-btn-saida').classList.toggle('active', tipoAtivo === 'SAIDA');
        document.getElementById('dash-btn-divida').classList.toggle('active', tipoAtivo === 'DIVIDA');

        let chart1Labels = [];
        let chart1Data = [];
        let chart1Colors = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#3b82f6', '#8b5cf6', '#ec4899', '#14b8a6', '#f43f5e', '#6366f1'];
        let title1 = '';

        if (tipoAtivo === 'TUDO') {
            title1 = 'Visão Global (Guaranis + Reais Convertidos)';
            
            const entBrl = this.transactionsData.filter(t => t.tipo === 'ENTRADA' && t.moeda === 'BRL').reduce((a, b) => a + b.valor, 0);
            const entPyg = this.transactionsData.filter(t => t.tipo === 'ENTRADA' && t.moeda === 'PYG').reduce((a, b) => a + b.valor, 0);
            const totalEnt = entPyg + (entBrl * taxa);

            const saiBrl = this.transactionsData.filter(t => t.tipo === 'SAIDA' && t.moeda === 'BRL').reduce((a, b) => a + b.valor, 0);
            const saiPyg = this.transactionsData.filter(t => t.tipo === 'SAIDA' && t.moeda === 'PYG').reduce((a, b) => a + b.valor, 0);
            const totalSai = saiPyg + (saiBrl * taxa);

            chart1Labels = ['Entradas Globais', 'Saídas Globais'];
            chart1Data = [totalEnt, totalSai];
            chart1Colors = ['#10b981', '#ef4444']; 
            
        } else {
            const baseData = this.transactionsData.filter(t => t.moeda === moedaAtiva && t.tipo === tipoAtivo);
            const originMap = {};
            
            baseData.forEach(t => {
                originMap[t.origem_destino] = (originMap[t.origem_destino] || 0) + t.valor;
            });

            chart1Labels = Object.keys(originMap);
            chart1Data = Object.values(originMap);

            const tipoNome = tipoAtivo === 'ENTRADA' ? 'Entradas' : tipoAtivo === 'SAIDA' ? 'Saídas' : 'Dívidas';
            title1 = `${tipoNome} por Origem (${moedaAtiva === 'BRL' ? 'R$' : '₲'})`;
        }

        document.getElementById('chartOriginsTitle').innerText = title1;

        // Limpa o gráfico de pizza anterior
        if (this.charts.expenses) this.charts.expenses.destroy();
        
        const ctxExpenses = document.getElementById('chartExpenses').getContext('2d');
        this.charts.expenses = new Chart(ctxExpenses, {
            type: 'doughnut',
            data: {
                labels: chart1Labels,
                datasets: [{
                    data: chart1Data,
                    backgroundColor: chart1Colors,
                    borderWidth: 2
                }]
            },
            options: { 
                responsive: true, 
                plugins: { 
                    legend: { display: false }, // Ocultamos a legenda padrão do Chart.js
                    tooltip: {
                        callbacks: {
                            label: function(context) {
                                let label = context.label || '';
                                if (label) label += ': ';
                                if (tipoAtivo === 'TUDO') {
                                    label += '₲ ' + context.parsed.toLocaleString('es-PY', {maximumFractionDigits: 0});
                                } else {
                                    label += (moedaAtiva === 'BRL' ? 'R$ ' : '₲ ') + context.parsed.toLocaleString(moedaAtiva === 'BRL' ? 'pt-BR' : 'es-PY');
                                }
                                return label;
                            }
                        }
                    }
                } 
            }
        });

        // Montagem da Legenda Customizada em HTML
        const totalSum = chart1Data.reduce((a, b) => a + b, 0);
        const legendContainer = document.getElementById('chart-legend');
        
        if (chart1Data.length === 0) {
            legendContainer.innerHTML = `<div style="text-align:center; color:#94a3b8; padding: 10px;">Sem dados para exibir</div>`;
        } else {
            legendContainer.innerHTML = chart1Labels.map((label, i) => {
                const val = chart1Data[i];
                const perc = totalSum > 0 ? ((val / totalSum) * 100).toFixed(1) : 0;
                const color = chart1Colors[i % chart1Colors.length];
                
                let prefix = tipoAtivo === 'TUDO' ? '₲ ' : (moedaAtiva === 'BRL' ? 'R$ ' : '₲ ');
                const isReal = moedaAtiva === 'BRL' && tipoAtivo !== 'TUDO';
                const valStr = prefix + val.toLocaleString(isReal ? 'pt-BR' : 'es-PY', {maximumFractionDigits: 0});

                return `
                    <div class="legend-item">
                        <div class="legend-left">
                            <div class="legend-color" style="background:${color}"></div>
                            <span>${label}</span>
                        </div>
                        <div class="legend-val">
                            ${valStr} <span style="font-size:0.75rem; color:#64748b; margin-left:4px; font-weight:normal;">(${perc}%)</span>
                        </div>
                    </div>
                `;
            }).join('');
        }
    }
};

window.app = app;
app.init();

if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js')
        .then(() => console.log("Service Worker Ativo"))
        .catch(err => console.log("Erro SW:", err));
}