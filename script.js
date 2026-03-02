const SB_URL = "https://alpyltplxrhrwxygkkar.supabase.co";
const SB_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFscHlsdHBseHJocnd4eWdra2FyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI0Njg5NDUsImV4cCI6MjA4ODA0NDk0NX0.QjM7L6sxNB4-LN3_x-ijo3MoZrpgzgkO8E79UUD2vUk";

const _supabase = supabase.createClient(SB_URL, SB_KEY);

const app = {
    currentFilter: 'TUDO',

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
        
        if (this.currentFilter !== 'TUDO') {
            query = query.eq('tipo', this.currentFilter);
        }

        const { data, error } = await query;
        if (!error) {
            this.render(data);
            this.updateTotals(data);
            this.updateDatalists(data);
        } else {
            console.error("Erro ao buscar dados:", error);
        }
    },

    updateTotals(data) {
        const brl = data.filter(t => t.moeda === 'BRL').reduce((acc, t) => acc + (t.tipo === 'ENTRADA' ? t.valor : -t.valor), 0);
        const pyg = data.filter(t => t.moeda === 'PYG').reduce((acc, t) => acc + (t.tipo === 'ENTRADA' ? t.valor : -t.valor), 0);
        
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
            btn.innerText = "Enviando...";

            let imageUrl = null;
            const file = document.getElementById('file-input').files[0];

            if (file) {
                const fileExt = file.name.split('.').pop();
                const fileName = `${Math.random()}.${fileExt}`;
                const { data, error: uploadError } = await _supabase.storage
                    .from('comprovantes')
                    .upload(fileName, file);
                
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
                comprovante_url: imageUrl,
                data: new Date().toISOString().split('T')[0]
            };

            const { error } = await _supabase.from('transacoes').insert([payload]);
            
            if (!error) {
                e.target.reset();
                this.closeModal();
                this.fetchData();
            } else {
                alert("Erro ao salvar: " + error.message);
            }
            btn.disabled = false;
            btn.innerText = "Salvar Registro";
        };
    },

    render(data) {
        const list = document.getElementById('transaction-list');
        list.innerHTML = data.map(t => `
            <div class="card" onclick="${t.comprovante_url ? `window.open('${t.comprovante_url}')` : ''}">
                <div class="card-info">
                    <h4>
                        ${t.origem_destino} 
                        ${t.comprovante_url ? '<span class="material-symbols-rounded has-photo">image</span>' : ''}
                    </h4>
                    <p>${t.local_dinheiro} • ${t.metodo}</p>
                    ${t.observacoes ? `<p style="font-size:0.75rem; font-style:italic; margin-top:3px;">"${t.observacoes}"</p>` : ''}
                </div>
                <div class="card-value">
                    <div class="val ${t.tipo === 'ENTRADA' ? 'plus' : ''}">
                        ${t.moeda === 'BRL' ? 'R$ ' : '₲ '}${t.valor.toLocaleString(t.moeda === 'BRL' ? 'pt-BR' : 'es-PY')}
                    </div>
                    <div class="date">${new Date(t.data).toLocaleDateString('pt-BR', { timeZone: 'UTC' })}</div>
                </div>
            </div>
        `).join('');
    },

    openModal(defaultType = 'SAIDA') {
        document.getElementById('type').value = defaultType;
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