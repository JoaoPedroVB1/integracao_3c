require('dotenv').config();
const axios = require('axios');
const express = require('express');
const https = require('https');
const app = express();

// --- CONFIGURAÇÕES ---
const PORT = 3000;
const HUBSPOT_TOKEN = process.env.HUBSPOT_TOKEN;
const TOKEN_3C = process.env.TOKEN_3C;

const INTERVALO_BUSCA = 60000; 
const chamadasProcessadas = new Set();
const cacheIdsRecentes = new Map();

// Ignora erro SSL
const agent = new https.Agent({  
  rejectUnauthorized: false
});

console.log('------------------------------------------------');
console.log('🤖 ROBÔ 3C RODANDO (Polling V10 - Registro Total)');
console.log(`🕒 Verificando a cada ${INTERVALO_BUSCA / 1000} segundos...`);
console.log('------------------------------------------------');

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

function formatarDataParaHubspot(dataRFC3339) {
    if (!dataRFC3339) return new Date().toLocaleString('pt-BR');
    const dataObj = new Date(dataRFC3339);
    return dataObj.toLocaleString('pt-BR', {
        timeZone: 'America/Sao_Paulo',
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
}

// DETETIVE DE NOMES
function descobrirNome(mailingData) {
    if (!mailingData || !mailingData.data) return null;

    let dados = mailingData.data;

    if (Array.isArray(dados)) {
        if (dados.length === 0) return null;
        dados = dados[0];
    }

    if (dados.Nome) return dados.Nome;
    if (dados.name) return dados.name;
    if (dados.Name) return dados.Name;
    if (dados.nome) return dados.nome;

    if (typeof dados === 'object') {
        const chaves = Object.keys(dados);
        const chaveNome = chaves.find(k => {
            const key = k.toLowerCase();
            return key.includes('nome') || 
                   key.includes('name') || 
                   key.includes('cliente') || 
                   key.includes('customer');
        });
        
        if (chaveNome) return dados[chaveNome];
    }

    return null;
}

async function buscarNovasChamadas() {
    try {
        const dataHoje = getDataHojeFormatada();
        
        const params = {
            api_token: TOKEN_3C,
            start_date: `${dataHoje} 00:00:00`,
            end_date: `${dataHoje} 23:59:59`,
            per_page: 100,
            with_mailing: true 
        };

        const url3c = `https://3c.fluxoti.com/api/v1/calls`;
        
        const response = await axios.get(url3c, { 
            params,
            httpsAgent: agent 
        });
        
        let listaChamadas = response.data.data || response.data;

        if (!Array.isArray(listaChamadas)) return;

        let novasChamadas = listaChamadas.filter(call => {
            const id = call.id || call._id;
            if (chamadasProcessadas.has(id)) return false;
            return true;
        });

        if (novasChamadas.length > 0) {
            console.log(`🔎 Encontrei ${novasChamadas.length} novas ocorrências.`);

            // Ordenação Cronológica (Antiga -> Recente)
            novasChamadas.sort((a, b) => {
                const dataA = new Date(a.call_date_rfc3339 || a.created_at);
                const dataB = new Date(b.call_date_rfc3339 || b.created_at);
                return dataA - dataB;
            });

            for (const call of novasChamadas) {
                const id = call.id || call._id;
                chamadasProcessadas.add(id);
                await enviarParaHubspot(call);
            }
        } 

    } catch (error) {
        console.error('❌ Erro na busca:', error.message);
    }
}

async function enviarParaHubspot(callData) {
    const callId = callData.id || callData._id;

    // --- 1. STATUS ---
    let statusFinal = "Sem tabulação";
    if (callData.qualification && callData.qualification !== "-" && callData.qualification !== "") {
        statusFinal = (typeof callData.qualification === 'object') ? callData.qualification.name : callData.qualification;
    } else if (callData.readable_status_text && callData.readable_status_text !== "-") {
        statusFinal = callData.readable_status_text;
    }

    // --- 2. REGRA CAIXA POSTAL ---
    const ehCaixaPostal = (statusFinal === "Caixa postal pós atendimento" || statusFinal === "Caixa Postal");
    const segundosFalados = converterTempoParaSegundos(callData.speaking_time);
    const sucessoNaLigacao = (segundosFalados > 0) && !ehCaixaPostal;

    // --- 3. DADOS DO CLIENTE ---
    const rawPhone = callData.number || "";
    const phone = rawPhone.toString().replace(/\D/g, ''); 
    if (!phone) return;

    // --- 4. EXTRAÇÃO DE NOME ---
    const nomeEncontrado = descobrirNome(callData.mailing_data);
    
    let nomeCompleto = null;
    let isNomeGenerico = true;

    if (nomeEncontrado && nomeEncontrado.trim() !== "" && nomeEncontrado !== "-") {
        nomeCompleto = nomeEncontrado;
        isNomeGenerico = false;
    } else {
        nomeCompleto = "Lead 3C";
        isNomeGenerico = true;
    }

    console.log(`🕵️ [DEBUG] Tel: ${phone} | Nome Final: "${nomeCompleto}"`);

    const dataFormatada = formatarDataParaHubspot(callData.call_date_rfc3339);

    try {
        let contactId = null;

        // Cache Local
        if (cacheIdsRecentes.has(phone)) {
            contactId = cacheIdsRecentes.get(phone);
        } 
        
        // Busca HubSpot
        if (!contactId) {
            const buscaHubspot = await axios.post(
                'https://api.hubapi.com/crm/v3/objects/contacts/search',
                { filterGroups: [{ filters: [{ propertyName: 'phone', operator: 'CONTAINS_TOKEN', value: phone }] }] },
                { headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` } }
            );

            if (buscaHubspot.data.total > 0) {
                contactId = buscaHubspot.data.results[0].id;
                cacheIdsRecentes.set(phone, contactId);
            }
        }

        // --- AÇÃO NO HUBSPOT ---

        if (contactId) {
            // >>> ATUALIZAÇÃO (Cliente Já Existe) <<<
            
            if (sucessoNaLigacao) {
                // SUCESSO: Atualiza tudo
                const linkAudio = `https://3c.fluxoti.com/api/v1/calls/${callId}/recording?api_token=${TOKEN_3C}`;

                const propsAtualizacao = {
                    status_ultima_ligacao: statusFinal,
                    ultima_gravacao_3c: linkAudio,
                    lead_contatado_: "true",
                    ultimo_contato_feito_em: dataFormatada
                };

                if (!isNomeGenerico) {
                    propsAtualizacao.firstname = nomeCompleto;
                }

                await axios.patch(
                    `https://api.hubapi.com/crm/v3/objects/contacts/${contactId}`,
                    { properties: propsAtualizacao },
                    { headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` } }
                );
                console.log(`💾 [ATENDIDA] Atualizado: ${phone} | ${statusFinal}`);

            } else {
                // FALHA: Atualiza só o campo de falha
                const propsSemSucesso = {
                    ultimo_contato_sem_sucesso: dataFormatada
                };
                await axios.patch(
                    `https://api.hubapi.com/crm/v3/objects/contacts/${contactId}`,
                    { properties: propsSemSucesso },
                    { headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` } }
                );
                
                if (ehCaixaPostal) {
                    console.log(`⚠️ [CAIXA POSTAL] 'sem sucesso' atualizado: ${phone}`);
                } else {
                    console.log(`⚠️ [NÃO ATENDIDA] 'sem sucesso' atualizado: ${phone}`);
                }
            }

        } else {
            // >>> CRIAÇÃO (Novo Cliente) <<<
            
            if (sucessoNaLigacao) {
                // ==========================
                // NOVO + ATENDEU (SUCESSO)
                // ==========================
                const linkAudio = `https://3c.fluxoti.com/api/v1/calls/${callId}/recording?api_token=${TOKEN_3C}`;

                const propsCriacao = {
                    phone: phone,
                    firstname: nomeCompleto,
                    status_ultima_ligacao: statusFinal,
                    ultima_gravacao_3c: linkAudio,
                    lead_contatado_: "true",
                    ultimo_contato_feito_em: dataFormatada
                };

                const createRes = await axios.post(
                    'https://api.hubapi.com/crm/v3/objects/contacts',
                    { properties: propsCriacao },
                    { headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` } }
                );

                cacheIdsRecentes.set(phone, createRes.data.id);
                console.log(`✨ [NOVO] Criado (Sucesso): ${nomeCompleto}`);

            } else {
                // ==================================
                // NOVO + NÃO ATENDEU (SEM SUCESSO)
                // ==================================
                // Cria com campos "Não atendida" conforme solicitado
                
                const propsCriacaoSemSucesso = {
                    phone: phone,
                    firstname: nomeCompleto,
                    
                    // Campos solicitados:
                    status_ultima_ligacao: "Sem sucesso",
                    ultima_gravacao_3c: "Não atendida",
                    ultimo_contato_feito_em: "Não atendida",
                    
                    // Data real da falha:
                    ultimo_contato_sem_sucesso: dataFormatada,
                    
                    // Opcional: define false pois não houve contato efetivo
                    lead_contatado_: "false" 
                };

                const createRes = await axios.post(
                    'https://api.hubapi.com/crm/v3/objects/contacts',
                    { properties: propsCriacaoSemSucesso },
                    { headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` } }
                );

                cacheIdsRecentes.set(phone, createRes.data.id);
                console.log(`🌑 [NOVO] Criado (Sem Sucesso): ${nomeCompleto}`);
            }
        }

    } catch (err) {
        console.error('❌ Erro HubSpot:', err.message);
        if(err.response) console.error(JSON.stringify(err.response.data, null, 2));
    }
}

setInterval(buscarNovasChamadas, INTERVALO_BUSCA);
buscarNovasChamadas(); 

app.listen(PORT, () => console.log(`🚀 Integração Rodando.`));