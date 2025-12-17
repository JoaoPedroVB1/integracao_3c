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
console.log('🤖 ROBÔ 3C RODANDO (Polling V8 - Regra Caixa Postal)');
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

    // --- 1. DETERMINA O STATUS PRIMEIRO ---
    let statusFinal = "Sem tabulação";
    if (callData.qualification && callData.qualification !== "-" && callData.qualification !== "") {
        statusFinal = (typeof callData.qualification === 'object') ? callData.qualification.name : callData.qualification;
    } else if (callData.readable_status_text && callData.readable_status_text !== "-") {
        statusFinal = callData.readable_status_text;
    }

    // --- 2. REGRA DE NEGÓCIO: CAIXA POSTAL ---
    // Verifica se o status é exatamente aquele que você quer ignorar
    const ehCaixaPostal = (statusFinal === "Caixa postal pós atendimento" || statusFinal === "Caixa Postal");

    // Verifica se tecnicamente houve áudio
    const segundosFalados = converterTempoParaSegundos(callData.speaking_time);
    
    // DECISÃO FINAL: Consideramos "Atendida com Sucesso" apenas se:
    // Tiver tempo falado E NÃO FOR caixa postal
    const sucessoNaLigacao = (segundosFalados > 0) && !ehCaixaPostal;

    // --- 3. DADOS DO CLIENTE ---
    const rawPhone = callData.number || "";
    const phone = rawPhone.toString().replace(/\D/g, ''); 
    if (!phone) return;

    let nomeCompleto = null;
    let isNomeGenerico = true;

    if (callData.mailing_data) {
        let dadosMailing = null;
        if (Array.isArray(callData.mailing_data.data) && callData.mailing_data.data.length > 0) {
            dadosMailing = callData.mailing_data.data[0];
        } else if (callData.mailing_data.data && !Array.isArray(callData.mailing_data.data)) {
            dadosMailing = callData.mailing_data.data;
        }

        if (dadosMailing && (dadosMailing.Nome || dadosMailing.name)) {
            nomeCompleto = dadosMailing.Nome || dadosMailing.name;
            isNomeGenerico = false;
        }
    }

    if (!nomeCompleto) {
        nomeCompleto = "Lead 3C";
    }

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

        // --- LÓGICA DE AÇÃO ---

        if (contactId) {
            // >>> CLIENTE JÁ EXISTE <<<
            
            if (sucessoNaLigacao) {
                // SUCESSO REAL (Conversa + Status Válido)
                // Atualiza tudo
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
                // FALHA OU CAIXA POSTAL
                // Atualiza apenas 'sem sucesso', preservando o status anterior
                const propsSemSucesso = {
                    ultimo_contato_sem_sucesso: dataFormatada
                };
                await axios.patch(
                    `https://api.hubapi.com/crm/v3/objects/contacts/${contactId}`,
                    { properties: propsSemSucesso },
                    { headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` } }
                );
                
                if (ehCaixaPostal) {
                    console.log(`⚠️ [CAIXA POSTAL] Tratado como 'sem sucesso': ${phone} (Status não alterado)`);
                } else {
                    console.log(`⚠️ [NÃO ATENDIDA] Atualizado 'sem sucesso': ${phone}`);
                }
            }

        } else {
            // >>> NOVO CLIENTE <<<
            
            // Só cria se for sucesso REAL (Conversa + Não é caixa postal)
            if (sucessoNaLigacao) {
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

                const newId = createRes.data.id;
                cacheIdsRecentes.set(phone, newId);
                console.log(`✨ [NOVO] Criado: ${nomeCompleto} | Status: ${statusFinal}`);

            } else {
                // Se for novo E for caixa postal (ou não atendida), ignoramos para não sujar o banco
                // console.log(`⏩ Ignorado (Novo + Sem Sucesso/Caixa Postal): ${phone}`);
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