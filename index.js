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

// --- NOVIDADE: CACHE ANTI-DUPLICIDADE ---
// Guarda os IDs criados nesta sessão para evitar criar duplicado 
// enquanto o HubSpot ainda está indexando.
const cacheIdsRecentes = new Map(); // Chave: Telefone -> Valor: ContactId

// Ignora erro SSL
const agent = new https.Agent({  
  rejectUnauthorized: false
});

console.log('------------------------------------------------');
console.log('🤖 ROBÔ 3C RODANDO (Polling V7 - Anti-Duplicidade)');
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

    // Verifica conversa
    const segundosFalados = converterTempoParaSegundos(callData.speaking_time);
    const teveConversa = segundosFalados > 0;

    // 1. Dados do Cliente
    const rawPhone = callData.number || "";
    const phone = rawPhone.toString().replace(/\D/g, ''); 
    if (!phone) return;

    // Lógica do Nome (Só Firstname)
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

        // PASSO A: Verifica Memória Local (Evita duplicidade em batch)
        if (cacheIdsRecentes.has(phone)) {
            contactId = cacheIdsRecentes.get(phone);
            // console.log(`🧠 Encontrado em cache local: ${phone} -> ID ${contactId}`);
        } 
        
        // PASSO B: Se não achou na memória, busca na API do HubSpot
        if (!contactId) {
            const buscaHubspot = await axios.post(
                'https://api.hubapi.com/crm/v3/objects/contacts/search',
                { filterGroups: [{ filters: [{ propertyName: 'phone', operator: 'CONTAINS_TOKEN', value: phone }] }] },
                { headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` } }
            );

            if (buscaHubspot.data.total > 0) {
                contactId = buscaHubspot.data.results[0].id;
                // Salva no cache para a próxima iteração
                cacheIdsRecentes.set(phone, contactId);
            }
        }

        // --- LÓGICA DE DECISÃO ---

        if (contactId) {
            // >>> UPDATE (Cliente Já Existe) <<<
            
            if (teveConversa) {
                // ATUALIZAÇÃO COMPLETA
                let statusFinal = "Sem tabulação";
                if (callData.qualification && callData.qualification !== "-" && callData.qualification !== "") {
                    statusFinal = (typeof callData.qualification === 'object') ? callData.qualification.name : callData.qualification;
                } else if (callData.readable_status_text && callData.readable_status_text !== "-") {
                    statusFinal = callData.readable_status_text;
                }

                const linkAudio = `https://3c.fluxoti.com/api/v1/calls/${callId}/recording?api_token=${TOKEN_3C}`;

                const propsAtualizacao = {
                    status_ultima_ligacao: statusFinal,
                    ultima_gravacao_3c: linkAudio,
                    lead_contatado_: "true",
                    ultimo_contato_feito_em: dataFormatada
                };

                // Atualiza nome apenas se tivermos um nome real (não genérico)
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
                // ATUALIZAÇÃO PARCIAL (Sem Sucesso)
                const propsSemSucesso = {
                    ultimo_contato_sem_sucesso: dataFormatada
                };
                await axios.patch(
                    `https://api.hubapi.com/crm/v3/objects/contacts/${contactId}`,
                    { properties: propsSemSucesso },
                    { headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` } }
                );
                console.log(`⚠️ [NÃO ATENDIDA] Atualizado 'sem sucesso': ${phone}`);
            }

        } else {
            // >>> CREATE (Novo Cliente) <<<
            
            // TRAVA DE SEGURANÇA: Só cria se teve conversa!
            if (teveConversa) {
                let statusFinal = "Sem tabulação";
                if (callData.qualification && callData.qualification !== "-" && callData.qualification !== "") {
                    statusFinal = (typeof callData.qualification === 'object') ? callData.qualification.name : callData.qualification;
                } else if (callData.readable_status_text && callData.readable_status_text !== "-") {
                    statusFinal = callData.readable_status_text;
                }

                const linkAudio = `https://3c.fluxoti.com/api/v1/calls/${callId}/recording?api_token=${TOKEN_3C}`;

                const propsCriacao = {
                    phone: phone,
                    firstname: nomeCompleto, // Apenas firstname
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

                // IMPORTANTE: Salva o ID do novo cliente no cache imediatamente!
                // Se a próxima chamada no loop for dele, o código vai cair no "if (contactId)" acima
                const newId = createRes.data.id;
                cacheIdsRecentes.set(phone, newId);

                console.log(`✨ [NOVO] Criado: ${nomeCompleto} | ID: ${newId}`);

            } else {
                // Não atendeu e não existe no HubSpot? IGNORE.
                // console.log(`⏩ Ignorado (Novo + Sem Conversa): ${phone}`);
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