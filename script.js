const SB_URL = "https://alpyltplxrhrwxygkkar.supabase.co";
const SB_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFscHlsdHBseHJocnd4eWdra2FyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI0Njg5NDUsImV4cCI6MjA4ODA0NDk0NX0.QjM7L6sxNB4-LN3_x-ijo3MoZrpgzgkO8E79UUD2vUk";

const _supabase = supabase.createClient(SB_URL, SB_KEY);

const app = {
    currentFilter: 'TUDO',
    transactionsData: [], // Cache local para buscar dados na edição

    async init() {
        this.setDefaultDate();
        await this.fetchData();
        this.setupForm();
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

        let query = _supabase.from('transacoes').select('*').order('data', { ascending: false });
        query = query.gte('data', start).lte('data', end);
        
        if (this.currentFilter !== 'TUDO') query = query.eq('tipo', this.currentFilter);

        const { data, error } = await query;
        if (!error) {
            this.transactionsData = data; // Salva no cache
            this.render(data);
            this.updateTotals(data);
            this.updateDatalists(data);
        } else {
            console.error("Erro ao buscar dados:", error);
        }
    },

    updateTotals(data) {
        // Dívidas pendentes/atrasadas não somam no saldo atual, apenas entradas e saídas normais
        const validos = data.filter(t => t.tipo !== 'DIVIDA' || t.status === 'PAGA');
        
        const brl = validos.filter(t => t.moeda === 'BRL').reduce((acc, t) => acc + (t.tipo === 'ENTRADA' ? t.valor : -t.valor), 0);
        const pyg = validos.filter(t => t.moeda === 'PYG').reduce((acc, t) => acc + (t.tipo === 'ENTRADA' ? t.valor : -t.valor), 0);
        
        document.getElementById('balance-brl').innerText = `R$ ${brl.toLocaleString('pt-BR', {minimumFractionDigits: 2})}`;
        document.getElementById('balance-pyg').innerText = `₲ ${pyg.toLocaleString('es-PY')}`;
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
            const txId = document.getElementById('tx-id').value; // Pega o ID (se existir)

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
                data: new Date().toISOString().split('T')[0]
            };

            // Se upou imagem nova, atualiza no banco. Se não, mantém a velha
            if (imageUrl) payload.comprovante_url = imageUrl;

            let error;
            if (txId) {
                // UPDATE (Edição)
                const res = await _supabase.from('transacoes').update(payload).eq('id', txId);
                error = res.error;
            } else {
                // INSERT (Novo)
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

    render(data) {
        const list = document.getElementById('transaction-list');
        list.innerHTML = data.map(t => `
            <div class="card">
                <div class="card-header-flex">
                    <div class="card-info" style="flex: 1;">
                        <div style="display:flex; align-items:center; gap:8px;">
                            <h4>${t.origem_destino}</h4>
                            ${t.comprovante_url ? `<span class="material-symbols-rounded has-photo" onclick="window.open('${t.comprovante_url}')" title="Ver Comprovante">image</span>` : ''}
                        </div>
                        <p>${t.local_dinheiro} • ${t.metodo}</p>
                        ${t.observacoes ? `<p style="font-size:0.75rem; font-style:italic; margin-top:3px; color: #94a3b8;">"${t.observacoes}"</p>` : ''}
                        ${t.tipo === 'DIVIDA' ? `<span class="status-badge status-${t.status || 'PENDENTE'}">${t.status || 'PENDENTE'}</span>` : ''}
                    </div>
                    <div class="card-value" style="text-align: right;">
                        <div class="val ${t.tipo === 'ENTRADA' ? 'plus' : ''}">
                            ${t.moeda === 'BRL' ? 'R$ ' : '₲ '}${t.valor.toLocaleString(t.moeda === 'BRL' ? 'pt-BR' : 'es-PY')}
                        </div>
                        <div class="date">${new Date(t.data).toLocaleDateString('pt-BR', { timeZone: 'UTC' })}</div>
                    </div>
                    <button class="btn-edit-icon" onclick="app.editTx('${t.id}')">
                        <span class="material-symbols-rounded">edit</span>
                    </button>
                </div>
            </div>
        `).join('');
    },

    // UX: Alterna o campo status dependendo do tipo selecionado
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

    // Abre o modal de INSERIR (Limpo)
    openModal(defaultType = 'SAIDA') {
        document.getElementById('finance-form').reset();
        document.getElementById('tx-id').value = '';
        document.getElementById('type').value = defaultType;
        document.getElementById('btn-delete').classList.add('hidden');
        document.querySelector('.modal-header h2').innerText = "Novo Registro";
        
        this.toggleStatus();

        document.getElementById('modal').classList.remove('hidden');
        setTimeout(() => document.getElementById('modal-content').classList.add('active'), 50);
    },

    // Abre o modal de EDITAR (Preenchido)
    editTx(id) {
        const t = this.transactionsData.find(x => x.id === id);
        if(!t) return;

        document.getElementById('tx-id').value = t.id;
        document.getElementById('type').value = t.tipo;
        document.getElementById('currency').value = t.moeda;
        document.getElementById('amount').value = t.valor;
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

    filterType(type) {
        this.currentFilter = type;
        document.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
        if(event) event.target.classList.add('active');
        this.fetchData();
    }
};

window.app = app;
app.init();

// Registro limpo do Service Worker
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js')
        .then(() => console.log("Service Worker Ativo"))
        .catch(err => console.log("Erro SW:", err));
}