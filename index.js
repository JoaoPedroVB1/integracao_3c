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

// Ignora erro SSL
const agent = new https.Agent({  
  rejectUnauthorized: false
});

console.log('------------------------------------------------');
console.log('🤖 ROBÔ 3C RODANDO (Polling V6 - Final)');
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

                // Agora passamos TODAS as chamadas para a função,
                // lá dentro decidimos se atualiza tudo ou só o campo de "sem sucesso".
                await enviarParaHubspot(call);
            }
        } 

    } catch (error) {
        console.error('❌ Erro na busca:', error.message);
    }
}

async function enviarParaHubspot(callData) {
    const callId = callData.id || callData._id;

    // --- VERIFICA SE TEVE CONVERSA ---
    const segundosFalados = converterTempoParaSegundos(callData.speaking_time);
    const teveConversa = segundosFalados > 0;

    // 1. Dados do Cliente
    const rawPhone = callData.number || "";
    const phone = rawPhone.toString().replace(/\D/g, ''); 
    if (!phone) return;

    // Lógica do Nome (Apenas Firstname)
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

    // Data Formatada
    const dataFormatada = formatarDataParaHubspot(callData.call_date_rfc3339);

    try {
        // Busca Contato no HubSpot
        const buscaHubspot = await axios.post(
            'https://api.hubapi.com/crm/v3/objects/contacts/search',
            { filterGroups: [{ filters: [{ propertyName: 'phone', operator: 'CONTAINS_TOKEN', value: phone }] }] },
            { headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` } }
        );

        // --- LÓGICA DE ATUALIZAÇÃO ---
        if (buscaHubspot.data.total > 0) {
            // >>> CLIENTE JÁ EXISTE <<<
            const contactId = buscaHubspot.data.results[0].id;

            if (teveConversa) {
                // ===============================================
                // CENÁRIO 1: Cliente Existe + Atendeu (Conversa)
                // ===============================================
                // Atualiza tudo (Status, Gravação, etc)

                // Define Status
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

                // Só atualiza o nome se não for genérico ("Lead 3C")
                // E usamos apenas firstname conforme solicitado
                if (!isNomeGenerico) {
                    propsAtualizacao.firstname = nomeCompleto;
                }

                await axios.patch(
                    `https://api.hubapi.com/crm/v3/objects/contacts/${contactId}`,
                    { properties: propsAtualizacao },
                    { headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` } }
                );
                console.log(`💾 [ATENDIDA] Cliente Atualizado: ${phone} | Status: ${statusFinal}`);

            } else {
                // ========================================================
                // CENÁRIO 2: Cliente Existe + NÃO Atendeu (Sem Conversa)
                // ========================================================
                // Atualiza APENAS o campo "ultimo_contato_sem_sucesso"

                const propsSemSucesso = {
                    ultimo_contato_sem_sucesso: dataFormatada
                };

                await axios.patch(
                    `https://api.hubapi.com/crm/v3/objects/contacts/${contactId}`,
                    { properties: propsSemSucesso },
                    { headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` } }
                );
                console.log(`⚠️ [NÃO ATENDIDA] Cliente Existe (${phone}). Atualizado campo 'ultimo_contato_sem_sucesso'.`);
            }

        } else {
            // >>> CLIENTE NÃO EXISTE <<<
            
            if (teveConversa) {
                // ===============================================
                // CENÁRIO 3: Novo Cliente + Atendeu
                // ===============================================
                // Cria o contato completo

                let statusFinal = "Sem tabulação";
                if (callData.qualification && callData.qualification !== "-" && callData.qualification !== "") {
                    statusFinal = (typeof callData.qualification === 'object') ? callData.qualification.name : callData.qualification;
                } else if (callData.readable_status_text && callData.readable_status_text !== "-") {
                    statusFinal = callData.readable_status_text;
                }

                const linkAudio = `https://3c.fluxoti.com/api/v1/calls/${callId}/recording?api_token=${TOKEN_3C}`;

                const propsCriacao = {
                    phone: phone,
                    firstname: nomeCompleto, // Nome completo vai aqui
                    // lastname: removido propositalmente
                    status_ultima_ligacao: statusFinal,
                    ultima_gravacao_3c: linkAudio,
                    lead_contatado_: "true",
                    ultimo_contato_feito_em: dataFormatada
                };
                
                await axios.post(
                    'https://api.hubapi.com/crm/v3/objects/contacts',
                    { properties: propsCriacao },
                    { headers: { Authorization: `Bearer ${HUBSPOT_TOKEN}` } }
                );
                console.log(`✨ [NOVO] Cliente Criado: ${nomeCompleto} | Status: ${statusFinal}`);

            } else {
                // ===============================================
                // CENÁRIO 4: Novo Cliente + NÃO Atendeu
                // ===============================================
                // IGNORAR. Não criamos contato novo se não houve conversa.
                // console.log(`⏩ Ignorado (0s e não existe no HubSpot): ${phone}`);
            }
        }
    } catch (err) {
        console.error('❌ Erro HubSpot:', err.message);
    }
}

setInterval(buscarNovasChamadas, INTERVALO_BUSCA);
buscarNovasChamadas(); 

app.listen(PORT, () => console.log(`🚀 Integração Rodando.`));