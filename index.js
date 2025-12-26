require('dotenv').config();
const axios = require('axios');
const express = require('express');
const https = require('https');
const app = express();

// --- CONFIGURAÇÕES ---
const PORT = process.env.PORT || 3000;
const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN;
const TOKEN_3C = process.env.TOKEN_3C;

const INTERVALO_BUSCA = 60000; // 60 segundos
const ITENS_POR_PAGINA = 500;  // Aumentado para 500 para reduzir requisições

// Memória de execução
const chamadasProcessadas = new Set(); 
const cacheIdsRecentes = new Map();    
let isProcessing = false; 

// Configuração do Axios com Timeout maior para aguentar cargas pesadas
const axiosInstance = axios.create({
    timeout: 30000, // 30 segundos de timeout
    httpsAgent: new https.Agent({ rejectUnauthorized: false })
});

console.log('------------------------------------------------');
console.log('🤖 ROBÔ 3C RODANDO (V16 - High Performance)');
console.log(`🚀 Lote por página: ${ITENS_POR_PAGINA} registros`);
console.log(`🔐 HUBSPOT_TOKEN set: ${Boolean(HUBSPOT_TOKEN)}`);
console.log(`🔐 TOKEN_3C set: ${Boolean(TOKEN_3C)}`);
console.log('------------------------------------------------');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function converterTempoParaSegundos(tempoString) {
    if (!tempoString || typeof tempoString !== 'string') return 0;
    const partes = tempoString.split(':'); 
    if (partes.length !== 3) return 0;
    return (parseInt(partes[0], 10) * 3600) + (parseInt(partes[1], 10) * 60) + parseInt(partes[2], 10);
}

function getDataHojeFormatada() {
    const date = new Date();
    const ano = date.getFullYear();
    const mes = String(date.getMonth() + 1).padStart(2, '0');
    const dia = String(date.getDate()).padStart(2, '0');
    return `${ano}-${mes}-${dia}`;
}

function formatarDataBrasileira(dataRFC3339) {
    if (!dataRFC3339) return new Date().toLocaleString('pt-BR');
    const dataObj = new Date(dataRFC3339);
    const dia = String(dataObj.getDate()).padStart(2, '0');
    const mes = String(dataObj.getMonth() + 1).padStart(2, '0'); 
    const ano = dataObj.getFullYear();
    const horas = String(dataObj.getHours()).padStart(2, '0');
    const minutos = String(dataObj.getMinutes()).padStart(2, '0');
    const segundos = String(dataObj.getSeconds()).padStart(2, '0');
    return `${dia}/${mes}/${ano} ${horas}:${minutos}:${segundos}`;
}

function limparTextoHTML(texto) {
    if (!texto) return null;
    let limpo = texto.toString();
    limpo = limpo.replace(/<[^>]*>?/gm, '');
    limpo = limpo.replace(/&nbsp;/gi, ' ');
    limpo = limpo.replace(/&amp;/gi, '&');
    limpo = limpo.replace(/^["']+|["']+$/g, '');
    limpo = limpo.replace(/\s+/g, ' ').trim();
    return limpo;
}

function descobrirNome(mailingData) {
    if (!mailingData || !mailingData.data) return null;
    let dados = mailingData.data;
    if (Array.isArray(dados)) {
        if (dados.length === 0) return null;
        dados = dados[0];
    }
    let nomeBruto = null;
    if (dados.Nome) nomeBruto = dados.Nome;
    else if (dados.name) nomeBruto = dados.name;
    else if (dados.Name) nomeBruto = dados.Name;
    else if (dados.nome) nomeBruto = dados.nome;
    else if (typeof dados === 'object') {
        const chaves = Object.keys(dados);
        const chaveNome = chaves.find(k => {
            const key = k.toLowerCase();
            return key.includes('nome') || key.includes('name') || key.includes('cliente') || key.includes('customer');
        });
        if (chaveNome) nomeBruto = dados[chaveNome];
    }
    return limparTextoHTML(nomeBruto);
}

// --- CICLO PRINCIPAL ---
async function cicloPrincipal() {
    if (isProcessing) { return; }
    isProcessing = true;
    
    try {
        await processarCicloCompleto();
    } catch (error) {
        console.error('❌ Erro fatal:', error.message);
    } finally {
        isProcessing = false;
        console.log(`💤 Ciclo concluído. Aguardando próximo...`);
        setTimeout(cicloPrincipal, INTERVALO_BUSCA);
    }
}

async function processarCicloCompleto() {
    const dataHoje = getDataHojeFormatada();
    console.log(`\n📅 DATA: ${dataHoje} | 🕒 Hora: ${new Date().toLocaleTimeString()}`);
    
    let offset = 0;
    let continuarBuscando = true;
    
    // USAMOS UM MAP PARA REMOVER DUPLICATAS AUTOMATICAMENTE
    // Se a API mandar o ID 123 na pagina 1 e de novo na pagina 2, o Map só guarda uma vez.
    const mapaChamadasDoDia = new Map();

    // 1. DOWNLOAD (BUFFERIZAÇÃO)
    console.log(`⬇️ Baixando dados do 3C (Lotes de ${ITENS_POR_PAGINA})...`);

    while (continuarBuscando) {
        try {
            const params = {
                api_token: TOKEN_3C,
                start_date: `${dataHoje} 00:00:00`,
                end_date: `${dataHoje} 23:59:59`,
                per_page: ITENS_POR_PAGINA,
                offset: offset,
                with_mailing: true 
            };

            const url3c = `https://3c.fluxoti.com/api/v1/calls`;
            const response = await axiosInstance.get(url3c, { params });
            const listaParcial = response.data.data || response.data;

            if (!Array.isArray(listaParcial) || listaParcial.length === 0) {
                continuarBuscando = false;
                break;
            }

            // Guarda no Map (Deduplicação instantânea)
            for (const call of listaParcial) {
                const id = call.id || call._id;
                // Só adiciona se a gente NUNCA processou esse ID na vida do robô
                if (!chamadasProcessadas.has(id)) {
                    mapaChamadasDoDia.set(id, call);
                }
            }

            process.stdout.write(`   📦 Baixados: ${mapaChamadasDoDia.size} novos registros acumulados... (Offset ${offset})\r`);

            if (listaParcial.length < ITENS_POR_PAGINA) {
                continuarBuscando = false;
            } else {
                offset += ITENS_POR_PAGINA;
            }

        } catch (error) {
            console.error(`\n❌ Erro no download (Offset ${offset}):`, error.message);
            // Se der erro de rede, paramos o download deste ciclo e processamos o que já temos
            continuarBuscando = false;
        }
    }

    // 2. PREPARAÇÃO
    // Converte Map para Array
    const listaFinal = Array.from(mapaChamadasDoDia.values());

    if (listaFinal.length === 0) {
        console.log('\n✅ Nenhuma chamada nova encontrada.');
        return;
    }

    console.log(`\n🔍 Processando ${listaFinal.length} chamadas únicas.`);
    console.log(`🔄 Ordenando cronologicamente (Antigo -> Novo)...`);

    // ORDENAÇÃO: Garante que a última chamada do dia seja a última a ser processada
    listaFinal.sort((a, b) => {
        const dataA = new Date(a.call_date_rfc3339 || a.created_at);
        const dataB = new Date(b.call_date_rfc3339 || b.created_at);
        return dataA - dataB;
    });

    // 3. ENVIO SEQUENCIAL
    console.log(`🚀 Enviando para o HubSpot...`);

    for (const call of listaFinal) {
        const id = call.id || call._id;
        
        // Marca como processada ANTES de enviar para evitar loops se der erro
        chamadasProcessadas.add(id);
        
        await enviarParaHubspot(call);
        
        // Pausa pequena para não travar o server
        await sleep(2000); 
    }
}

async function enviarParaHubspot(callData) {
    const callId = callData.id || callData._id;

    // 1. Status
    let statusFinal = "Sem tabulação";
    if (callData.qualification && callData.qualification !== "-" && callData.qualification !== "") {
        statusFinal = (typeof callData.qualification === 'object') ? callData.qualification.name : callData.qualification;
    } else if (callData.readable_status_text && callData.readable_status_text !== "-") {
        statusFinal = callData.readable_status_text;
    }

    // 2. Regra Caixa Postal
    const ehCaixaPostal = (statusFinal === "Caixa postal pós atendimento" || statusFinal === "Caixa Postal");
    const segundosFalados = converterTempoParaSegundos(callData.speaking_time);
    const sucessoNaLigacao = (segundosFalados > 0) && !ehCaixaPostal;

    // 3. Telefone
    const rawPhone = callData.number || "";
    const phone = rawPhone.toString().replace(/\D/g, ''); 
    if (!phone) return;

    // 4. Nome
    const nomeEncontrado = descobrirNome(callData.mailing_data);
    let nomeCompleto = null;
    let isNomeGenerico = true;

    if (nomeEncontrado && nomeEncontrado !== "" && nomeEncontrado !== "-") {
        nomeCompleto = nomeEncontrado;
        isNomeGenerico = false;
    } else {
        nomeCompleto = "Lead 3C";
        isNomeGenerico = true;
    }

    console.log(`🕵️ [DEBUG] Tel: ${phone} | Nome: "${nomeCompleto}"`);

    const dataFormatada = formatarDataBrasileira(callData.call_date_rfc3339);

    try {
        let contactId = null;

        if (cacheIdsRecentes.has(phone)) {
            contactId = cacheIdsRecentes.get(phone);
        } 
        
        if (!contactId) {
            const buscaHubspot = await axiosInstance.post(
                'https://api.hubapi.com/crm/v3/objects/contacts/search',
                { filterGroups: [{ filters: [{ propertyName: 'phone', operator: 'CONTAINS_TOKEN', value: phone }] }] },
                { headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` } }
            );

            if (buscaHubspot.data.total > 0) {
                contactId = buscaHubspot.data.results[0].id;
                cacheIdsRecentes.set(phone, contactId);
            }
        }

        if (contactId) {
            // >>> UPDATE
            if (sucessoNaLigacao) {
                const linkAudio = `https://3c.fluxoti.com/api/v1/calls/${callId}/recording?api_token=${TOKEN_3C}`;
                const props = {
                    status_ultima_ligacao: statusFinal,
                    ultima_gravacao_3c: linkAudio,
                    lead_contatado_: "true",
                    ultimo_contato_feito_em: dataFormatada
                };
                if (!isNomeGenerico) props.firstname = nomeCompleto;

                await axiosInstance.patch(`https://api.hubapi.com/crm/v3/objects/contacts/${contactId}`, { properties: props }, { headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` } });
                console.log(`💾 [ATUALIZADO] ${phone} | ${statusFinal}`);
            } else {
                const props = { ultimo_contato_sem_sucesso: dataFormatada };
                await axiosInstance.patch(`https://api.hubapi.com/crm/v3/objects/contacts/${contactId}`, { properties: props }, { headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` } });
                console.log(`⚠️ [SEM SUCESSO] ${phone} | Data atualizada`);
            }
        } else {
            // >>> CREATE
            if (cacheIdsRecentes.has(phone)) return;

            if (sucessoNaLigacao) {
                const linkAudio = `https://3c.fluxoti.com/api/v1/calls/${callId}/recording?api_token=${TOKEN_3C}`;
                const props = {
                    phone: phone,
                    firstname: nomeCompleto,
                    status_ultima_ligacao: statusFinal,
                    ultima_gravacao_3c: linkAudio,
                    lead_contatado_: "true",
                    ultimo_contato_feito_em: dataFormatada
                };
                const res = await axiosInstance.post('https://api.hubapi.com/crm/v3/objects/contacts', { properties: props }, { headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` } });
                cacheIdsRecentes.set(phone, res.data.id);
                console.log(`✨ [CRIADO - SUCESSO] ${nomeCompleto}`);
            } else {
                const props = {
                    phone: phone,
                    firstname: nomeCompleto,
                    status_ultima_ligacao: "Sem sucesso",
                    ultima_gravacao_3c: "Não atendida",
                    ultimo_contato_feito_em: "Não atendida",
                    ultimo_contato_sem_sucesso: dataFormatada,
                    lead_contatado_: "false" 
                };
                const res = await axiosInstance.post('https://api.hubapi.com/crm/v3/objects/contacts', { properties: props }, { headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` } });
                cacheIdsRecentes.set(phone, res.data.id);
                console.log(`🌑 [CRIADO - SEM SUCESSO] ${nomeCompleto}`);
            }
        }

    } catch (err) {
        console.error('❌ Erro HubSpot:', err.message);
    }
}

app.get('/health', (req, res) => {
    res.status(200).send('ok');
});

cicloPrincipal();

app.listen(PORT, () => console.log(`🚀 Integração Rodando na porta ${PORT}.`));
