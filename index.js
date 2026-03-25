require('dotenv').config();
const {
  Client, GatewayIntentBits, ActionRowBuilder,
  ButtonBuilder, ButtonStyle, EmbedBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle,
  SlashCommandBuilder, REST, Routes
} = require('discord.js');
const fs = require('fs');

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// ─── RANGOS EN ORDEN ─────────────────────────────────────────────────────────
const RANGOS = [
  { nombre: 'Aspirante',           id: '1485416321473839155' },
  { nombre: 'Oficial en Práctica', id: '1485433681895227403' },
  { nombre: 'Oficial de Patrulla', id: '1485434261334003813' },
  { nombre: 'Oficial II',          id: '1485434387825954867' },
  { nombre: 'Oficial III',         id: '1485434494180790342' },
  { nombre: 'Detective',           id: '1485434632357941308' },
  { nombre: 'Sargento',            id: '1485434748573585479' },
  { nombre: 'Teniente',            id: '1485434853359878226' },
  { nombre: 'Capitán',             id: '1485434924017254502' },
  { nombre: 'Comandante',          id: '1485435005881548860' },
  { nombre: 'Subjefe de Policía',  id: '1485435090426400901' },
  { nombre: 'Jefe de Policía',     id: '1485435169136447539' },
];

const INACTIVIDAD_DIAS = 5;
const MAX_TURNO_MS = 30 * 60 * 1000; // 30 minutos

const DATA_FILE = './data.json';

function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify({ sessions: {}, history: {}, pendingBitacora: {}, sanciones: {} }));
  }
  const data = JSON.parse(fs.readFileSync(DATA_FILE));
  if (!data.pendingBitacora) data.pendingBitacora = {};
  if (!data.sanciones) data.sanciones = {};
  return data;
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

function formatDuration(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  return `${h}h ${m}m ${s}s`;
}

function getRangoActual(member) {
  for (let i = RANGOS.length - 1; i >= 0; i--) {
    if (member.roles.cache.has(RANGOS[i].id)) return RANGOS[i];
  }
  return null;
}

// ─── REGISTRAR SLASH COMMANDS ─────────────────────────────────────────────────
async function registerCommands(guildId) {
  const commands = [
    new SlashCommandBuilder()
      .setName('ascender')
      .setDescription('Sube de rango a un oficial')
      .addUserOption(o => o.setName('oficial').setDescription('Oficial a ascender').setRequired(true)),
    new SlashCommandBuilder()
      .setName('ficha')
      .setDescription('Ver ficha de un oficial')
      .addUserOption(o => o.setName('oficial').setDescription('Oficial a consultar').setRequired(false)),
    new SlashCommandBuilder()
      .setName('sancionar')
      .setDescription('Aplicar advertencia a un oficial')
      .addUserOption(o => o.setName('oficial').setDescription('Oficial a sancionar').setRequired(true))
      .addStringOption(o => o.setName('motivo').setDescription('Motivo de la sanción').setRequired(true)),
    new SlashCommandBuilder()
      .setName('buscar')
      .setDescription('Ver historial completo de un oficial')
      .addUserOption(o => o.setName('oficial').setDescription('Oficial a buscar').setRequired(true)),
    new SlashCommandBuilder()
      .setName('resetear_horas')
      .setDescription('Resetea las horas de todos los oficiales (solo Staff)'),
    new SlashCommandBuilder()
      .setName('cerrar_turno')
      .setDescription('Cierra el turno de un oficial (solo Alto Mando/Staff)')
      .addUserOption(o => o.setName('oficial').setDescription('Oficial al que cerrar el turno').setRequired(true)),
    new SlashCommandBuilder()
      .setName('test_alertas')
      .setDescription('Prueba las alertas de inactividad y turno largo (solo Staff)'),
    new SlashCommandBuilder()
      .setName('baja')
      .setDescription('Da de baja a un oficial y le quita todos los roles')
      .addUserOption(o => o.setName('oficial').setDescription('Oficial a dar de baja').setRequired(true))
      .addStringOption(o => o.setName('motivo').setDescription('Motivo de la baja').setRequired(true)),
    new SlashCommandBuilder()
      .setName('solicitar_ascenso')
      .setDescription('Solicita un ascenso de rango'),
    new SlashCommandBuilder()
      .setName('solicitar_vacaciones')
      .setDescription('Solicita vacaciones o permiso')
      .addStringOption(o => o.setName('motivo').setDescription('Motivo o duración').setRequired(true)),
    new SlashCommandBuilder()
      .setName('estadisticas')
      .setDescription('Muestra estadísticas generales del servidor'),
  ].map(c => c.toJSON());

  const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);
  await rest.put(Routes.applicationGuildCommands(client.user.id, guildId), { body: commands });
  console.log('Slash commands registrados.');
}

// ─── MENSAJES FIJOS ───────────────────────────────────────────────────────────
async function sendBitacoraMessage(channel) {
  const embed = new EmbedBuilder()
    .setTitle('📋 Bitácora Policial - LSPD')
    .setDescription('Registra tu tiempo de servicio activo.\nPresiona **Iniciar Turno** cuando comiences y **Finalizar Turno** cuando termines.')
    .setColor(0x1e90ff)
    .setFooter({ text: 'Sistema de control de horas LSPD' });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('iniciar_turno').setLabel('🟢 Iniciar Turno').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('finalizar_turno').setLabel('🔴 Finalizar Turno').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('ver_horas_staff').setLabel('📊 Ver Horas (Staff)').setStyle(ButtonStyle.Primary),
  );

  await channel.send({ embeds: [embed], components: [row] });
}

async function updateActivosMessage() {
  const data = loadData();
  const activosChannel = await client.channels.fetch(process.env.ACTIVOS_CHANNEL_ID).catch((e) => {
    console.error('Error fetching activos channel:', e.message);
    return null;
  });
  if (!activosChannel) return;

  const sessions = data.sessions;
  const now = Date.now();
  let descripcion = '';

  if (Object.keys(sessions).length === 0) {
    descripcion = '*No hay oficiales en servicio actualmente.*';
  } else {
    descripcion = Object.entries(sessions).map(([uid]) => {
      return `🟢 <@${uid}> — en servicio`;
    }).join('\n');
  }

  const embed = new EmbedBuilder()
    .setTitle('🚔 Unidades Activas – LSPD')
    .setDescription(descripcion)
    .setColor(0x00ff7f)
    .setFooter({ text: `Actualizado` })
    .setTimestamp();

  const msgs = await activosChannel.messages.fetch({ limit: 5 });
  const existing = msgs.find(m => m.author.id === client.user.id);
  if (existing) {
    await existing.edit({ embeds: [embed] });
    console.log('Activos actualizado.');
  } else {
    await activosChannel.send({ embeds: [embed] });
    console.log('Activos enviado.');
  }
}

async function sendCodigosMessage(channel) {
  const embed = new EmbedBuilder()
    .setTitle('📻 Códigos Radiales – LSPD UnderGroundRP')
    .setColor(0x1a1a2e)
    .setDescription('Los códigos radiales son claves de comunicación rápida que permiten a los oficiales coordinarse de manera eficiente y segura durante el servicio. Su uso correcto garantiza orden, disciplina y respuesta inmediata en situaciones críticas.')
    .addFields(
      { name: '🔢 Códigos Básicos', value: [
        '`Código 0` → Oficial en peligro, apoyo inmediato.',
        '`Código 2` → Llamada urgente silenciosa (solo luces).',
        '`Código 3` → Llamada urgente rápida (sirenas activas).',
        '`Código 4` → Situación controlada.',
        '`Código 5` → No concurrir patrullas.',
        '`Código 7` → Fuera de servicio temporal.',
      ].join('\n')},
      { name: '📋 Códigos "10" más usados', value: [
        '`10-4` → Recibido / afirmativo.',
        '`10-9` → Repita el mensaje.',
        '`10-19` → Regreso a la central.',
        '`10-20` → Solicitud de ubicación.',
        '`10-31` → Persona sospechosa.',
        '`10-32` → Se requiere unidad de apoyo.',
        '`10-46` → Accidente con heridos.',
        '`10-74` → Negativo.',
      ].join('\n')},
      { name: '⚖️ Normas de Uso', value: [
        '🔹 **Claridad** — Usar el código exacto en su contexto.',
        '🔹 **Disciplina** — Evitar improvisaciones o claves inventadas.',
        '🔹 **Seguridad** — Un código correcto puede salvar vidas.',
        '🔹 **Uniformidad** — Todos los oficiales deben conocerlos y aplicarlos igual.',
      ].join('\n')},
    )
    .setFooter({ text: 'Comandancia LSPD – UnderGroundRP' })
    .setTimestamp();

  await channel.send({ embeds: [embed] });
}

async function sendReglamentoMessage(channel) {
  const embed1 = new EmbedBuilder()
    .setTitle('📜 REGLAMENTO OFICIAL – LSPD UnderGroundRP')
    .setColor(0x1a1a2e)
    .setDescription([
      'El cumplimiento de los reglamentos es la base de la disciplina y el orden dentro del **Departamento de Policía de Los Santos**.',
      'Cada oficial, desde aspirantes hasta el Alto Mando, debe conocer y respetar estas normas.',
      '',
      '> *El desconocimiento del reglamento no exime de responsabilidad. El incumplimiento será sancionado conforme a la normativa vigente.*',
    ].join('\n'))
    .addFields(
      { name: '⚖️ Principios Fundamentales', value: [
        '🔹 **Disciplina** — Conducta profesional, respetuosa y acorde a la jerarquía en todo momento.',
        '🔹 **Responsabilidad** — El uso de herramientas, canales y comandos debe ser correcto y justificado.',
        '🔹 **Transparencia** — Toda acción debe quedar registrada en bitácoras y reportes oficiales.',
        '🔹 **Compromiso** — El servicio exige dedicación, puntualidad y cumplimiento de turnos.',
        '🔹 **Respeto institucional** — Las decisiones del Alto Mando son obligatorias y deben acatarse sin excepción.',
      ].join('\n')},
    )
    .setFooter({ text: 'Comandancia LSPD – UnderGroundRP' });

  const embed2 = new EmbedBuilder()
    .setTitle('📋 Normas de Conducta')
    .setColor(0x1e3a5f)
    .addFields(
      { name: '🎙️ Comunicación', value: [
        '• Usar lenguaje formal y respetuoso en todos los canales oficiales.',
        '• Prohibido el uso de insultos, discriminación o lenguaje inapropiado.',
        '• Las comunicaciones por radio deben ser breves, claras y con códigos 10.',
        '• No interrumpir comunicaciones de superiores en operaciones activas.',
      ].join('\n')},
      { name: '🚔 Operaciones', value: [
        '• Todo oficial debe registrar su turno al iniciar y finalizar servicio.',
        '• Las bitácoras operativas son obligatorias al finalizar cada turno.',
        '• Está prohibido actuar fuera de protocolo sin autorización superior.',
        '• El uso de fuerza excesiva será investigado y sancionado.',
      ].join('\n')},
      { name: '👮 Jerarquía', value: [
        '• Saludar a superiores al iniciar servicio es obligatorio.',
        '• Las órdenes de un superior deben cumplirse de inmediato.',
        '• Los desacuerdos se expresan por canales internos, nunca en público.',
        '• Suplantar o irrespetar un rango superior es falta grave.',
      ].join('\n')},
    );

  const embed3 = new EmbedBuilder()
    .setTitle('⚠️ Faltas y Sanciones')
    .setColor(0x8b0000)
    .addFields(
      { name: '🟡 Faltas Leves', value: [
        '• Llegar tarde al turno sin aviso previo.',
        '• No registrar bitácora al finalizar servicio.',
        '• Uso informal del lenguaje en canales oficiales.',
        '**Sanción:** Advertencia verbal o escrita.',
      ].join('\n')},
      { name: '🟠 Faltas Graves', value: [
        '• Desobedecer órdenes directas de un superior.',
        '• Falsificar información en bitácoras o reportes.',
        '• Conducta irrespetuosa hacia compañeros o superiores.',
        '**Sanción:** Suspensión temporal o degradación de rango.',
      ].join('\n')},
      { name: '🔴 Faltas Muy Graves', value: [
        '• Filtrar información interna del departamento.',
        '• Colaborar con organizaciones criminales.',
        '• Acoso, discriminación o comportamiento tóxico reiterado.',
        '**Sanción:** Baja inmediata y permanente del departamento.',
      ].join('\n')},
    )
    .setFooter({ text: 'Comandancia LSPD – UnderGroundRP • Versión vigente' })
    .setTimestamp();

  await channel.send({ embeds: [embed1] });
  await channel.send({ embeds: [embed2] });
  await channel.send({ embeds: [embed3] });
}

async function sendRangosMessage(channel) {
  const embed = new EmbedBuilder()
    .setTitle('🏛️ Escala de Rangos – LSPD UnderGroundRP')
    .setColor(0x1e3a5f)
    .setDescription([
      '> Todo miembro del departamento debe respetar la jerarquía institucional.',
      '> Las órdenes de un superior son de cumplimiento obligatorio.',
      '> El irrespeto a un rango superior será sancionado.',
      '',
      '**📋 Escala de Formación y Base**',
      '`1.` 🟦 Aspirante',
      '`2.` 🟦 Oficial en Práctica',
      '`3.` 🟦 Oficial de Patrulla',
      '',
      '**📋 Escala Intermedia**',
      '`4.` 🟨 Oficial II',
      '`5.` 🟨 Oficial III',
      '`6.` 🟨 Detective',
      '',
      '**📋 Escala de Supervisión**',
      '`7.` 🟧 Sargento',
      '`8.` 🟧 Teniente',
      '`9.` 🟧 Capitán',
      '',
      '**📋 Escala de Comando**',
      '`10.` 🟥 Comandante',
      '`11.` 🟥 Subjefe de Policía',
      '`12.` 🟥 Jefe de Policía',
    ].join('\n'))
    .addFields(
      { name: '📌 Normas de Jerarquía', value: [
        '• Saluda a tus superiores al iniciar servicio.',
        '• No cuestiones órdenes en público, hazlo por los canales internos.',
        '• Un rango superior tiene prioridad en decisiones operativas.',
        '• El ascenso se gana con desempeño, horas de servicio y conducta.',
        '• Faltar el respeto a un superior es motivo de sanción inmediata.',
      ].join('\n')},
    )
    .setFooter({ text: 'Comandancia LSPD – UnderGroundRP' })
    .setTimestamp();

  await channel.send({ embeds: [embed] });
}

async function sendPostulacionMessage(channel) {
  const embed = new EmbedBuilder()
    .setTitle('🚔 Postulación – LSPD UnderGroundRP')
    .setDescription([
      '¿Quieres formar parte del **Los Santos Police Department**?',
      '',
      'Presiona el botón para iniciar tu postulación.',
      'El proceso consta de **2 pasos** con preguntas sobre tu perfil y experiencia.',
      '',
      '> Solo el personal autorizado puede ver y responder las postulaciones.',
    ].join('\n'))
    .setColor(0x1e90ff)
    .setFooter({ text: 'Comandancia LSPD – UnderGroundRP' });
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('btn_postular').setLabel('📋 Iniciar Postulación').setStyle(ButtonStyle.Primary),
  );
  await channel.send({ embeds: [embed], components: [row] });
}

async function sendAscensoMessage(channel) {
  const embed = new EmbedBuilder()
    .setTitle('🎖️ Solicitud de Ascenso – LSPD')
    .setDescription('Presiona el botón para enviar una solicitud de ascenso a Comandancia.\nSe notificará automáticamente cuando sea revisada.')
    .setColor(0xffd700)
    .setFooter({ text: 'Comandancia LSPD – UnderGroundRP' });
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('btn_solicitar_ascenso').setLabel('📋 Solicitar Ascenso').setStyle(ButtonStyle.Primary),
  );
  await channel.send({ embeds: [embed], components: [row] });
}

async function sendVacacionesMessage(channel) {
  const embed = new EmbedBuilder()
    .setTitle('🏖️ Solicitud de Vacaciones / Permiso – LSPD')
    .setDescription('Presiona el botón para enviar una solicitud de vacaciones o permiso a Comandancia.')
    .setColor(0x00bfff)
    .setFooter({ text: 'Comandancia LSPD – UnderGroundRP' });
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('btn_solicitar_vacaciones').setLabel('🏖️ Solicitar Vacaciones').setStyle(ButtonStyle.Primary),
  );
  await channel.send({ embeds: [embed], components: [row] });
}

async function sendAdminMessage(channel) {
  const embed = new EmbedBuilder()
    .setTitle('⚙️ Panel de Administración – LSPD')
    .setDescription('Herramientas exclusivas para Alto Mando y Staff.')
    .setColor(0xff4500)
    .setFooter({ text: 'Comandancia LSPD – UnderGroundRP' });
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('btn_estadisticas').setLabel('📊 Estadísticas').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('btn_baja').setLabel('🚨 Dar de Baja').setStyle(ButtonStyle.Danger),
  );
  await channel.send({ embeds: [embed], components: [row] });
}

async function sendOperativaMessage(channel) {
  const embed = new EmbedBuilder()
    .setTitle('📁 Bitácora Operativa – LSPD UndergroundRP')
    .setDescription('Presiona el botón para registrar una nueva bitácora de turno.\nPuedes adjuntar fotos de detenidos en el siguiente paso.')
    .setColor(0x2f3136)
    .setFooter({ text: 'Comandancia LSPD – UnderGroundRP' });

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('nueva_bitacora').setLabel('📝 Nueva Bitácora').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('nueva_bitacora_firma').setLabel('✍️ Firma Automática').setStyle(ButtonStyle.Secondary),
  );

  await channel.send({ embeds: [embed], components: [row] });
}

// ─── READY ────────────────────────────────────────────────────────────────────
client.once('clientReady', async () => {
  console.log(`Bot conectado como ${client.user.tag}`);

  const guild = client.guilds.cache.first();
  if (guild) await registerCommands(guild.id);

  const bitacoraChannel = await client.channels.fetch(process.env.BITACORA_CHANNEL_ID).catch(() => null);
  if (bitacoraChannel) {
    const msgs = await bitacoraChannel.messages.fetch({ limit: 10 });
    if (!msgs.find(m => m.author.id === client.user.id && m.components.length > 0))
      await sendBitacoraMessage(bitacoraChannel);
  }

  const operativaChannel = await client.channels.fetch(process.env.OPERATIVA_CHANNEL_ID).catch(() => null);
  if (operativaChannel) {
    const msgs = await operativaChannel.messages.fetch({ limit: 10 });
    if (!msgs.find(m => m.author.id === client.user.id && m.components.length > 0))
      await sendOperativaMessage(operativaChannel);
  }

  // Canal rangos
  const rangosChannel = await client.channels.fetch(process.env.RANGOS_CHANNEL_ID).catch(() => null);
  if (rangosChannel) {
    const msgs = await rangosChannel.messages.fetch({ limit: 10 });
    if (!msgs.find(m => m.author.id === client.user.id))
      await sendRangosMessage(rangosChannel);
  }

  // Canal postulación
  const postulacionChannel = await client.channels.fetch(process.env.POSTULACION_CHANNEL_ID).catch(() => null);
  if (postulacionChannel) {
    const msgs = await postulacionChannel.messages.fetch({ limit: 10 });
    if (!msgs.find(m => m.author.id === client.user.id && m.components.length > 0))
      await sendPostulacionMessage(postulacionChannel);
  }

  // Canal solicitud ascenso
  const ascensoChannel = await client.channels.fetch(process.env.ASCENSO_CHANNEL_ID).catch(() => null);
  if (ascensoChannel) {
    const msgs = await ascensoChannel.messages.fetch({ limit: 10 });
    if (!msgs.find(m => m.author.id === client.user.id && m.components.length > 0))
      await sendAscensoMessage(ascensoChannel);
  }

  // Canal solicitud vacaciones
  const vacacionesChannel = await client.channels.fetch(process.env.VACACIONES_CHANNEL_ID).catch(() => null);
  if (vacacionesChannel) {
    const msgs = await vacacionesChannel.messages.fetch({ limit: 10 });
    if (!msgs.find(m => m.author.id === client.user.id && m.components.length > 0))
      await sendVacacionesMessage(vacacionesChannel);
  }

  // Canal admin
  const adminChannel = await client.channels.fetch(process.env.ADMIN_CHANNEL_ID).catch(() => null);
  if (adminChannel) {
    const msgs = await adminChannel.messages.fetch({ limit: 10 });
    if (!msgs.find(m => m.author.id === client.user.id && m.components.length > 0))
      await sendAdminMessage(adminChannel);
  }

  // Chequeo periódico cada 10 minutos
  setInterval(() => checkTurnosLargos(), 10 * 60 * 1000);
  setInterval(() => checkInactividad(), 60 * 60 * 1000);
  updateActivosMessage();

  // Canal códigos radiales
  const codigosChannel = await client.channels.fetch(process.env.CODIGOS_CHANNEL_ID).catch(() => null);
  if (codigosChannel) {
    const msgsCod = await codigosChannel.messages.fetch({ limit: 10 });
    if (!msgsCod.find(m => m.author.id === client.user.id))
      await sendCodigosMessage(codigosChannel);
  }

  // Canal reglamento
  const reglamentoChannel = await client.channels.fetch(process.env.REGLAMENTO_CHANNEL_ID).catch(() => null);
  if (reglamentoChannel) {
    const msgsRegl = await reglamentoChannel.messages.fetch({ limit: 10 });
    if (!msgsRegl.find(m => m.author.id === client.user.id))
      await sendReglamentoMessage(reglamentoChannel);
  }

  // Reseteo semanal cada domingo — calcula ms hasta el próximo domingo a esta hora
  const ahora = new Date();
  const diasHastaDomingo = (7 - ahora.getDay()) % 7 || 7;
  const proximoDomingo = new Date(ahora);
  proximoDomingo.setDate(ahora.getDate() + diasHastaDomingo);
  proximoDomingo.setSeconds(0, 0);
  const msHastaDomingo = proximoDomingo - ahora;
  setTimeout(() => {
    resetearHorasSemanal();
    setInterval(() => resetearHorasSemanal(), 7 * 24 * 60 * 60 * 1000);
  }, msHastaDomingo);
  console.log(`Próximo reseteo: ${proximoDomingo.toLocaleString('es-CL')}`);
});

// ─── RESETEO SEMANAL ─────────────────────────────────────────────────────────
async function resetearHorasSemanal() {
  const data = loadData();
  const resetChannel = await client.channels.fetch(process.env.RESET_CHANNEL_ID).catch(() => null);

  if (resetChannel) {
    const lines = Object.values(data.history)
      .sort((a, b) => b.totalMs - a.totalMs)
      .map((u, i) => `${i + 1}. **${u.username}** — ${formatDuration(u.totalMs)}`)
      .join('\n');

    const embed = new EmbedBuilder()
      .setTitle('📊 Resumen Semanal – LSPD')
      .setDescription(lines || 'Sin registros esta semana.')
      .setColor(0xffd700)
      .setFooter({ text: 'Las horas han sido reseteadas para la nueva semana.' })
      .setTimestamp();

    await resetChannel.send({ embeds: [embed] });
  }

  data.history = {};
  data.sessions = {};
  saveData(data);
  console.log('Horas reseteadas automáticamente.');
}

// ─── CHEQUEO TURNOS LARGOS ────────────────────────────────────────────────────
async function checkTurnosLargos() {
  const data = loadData();
  const now = Date.now();
  for (const [userId, session] of Object.entries(data.sessions)) {
    if (now - session.start > MAX_TURNO_MS) {
      const inactividadChannel = await client.channels.fetch(process.env.INACTIVIDAD_CHANNEL_ID).catch(() => null);
      if (inactividadChannel) {
        await inactividadChannel.send({
          content: `⚠️ <@${userId}> lleva más de 30 minutos con el turno abierto sin cerrarlo. Staff o Alto Mando puede cerrarlo con \`/cerrar_turno\`.`
        });
      }
    }
  }
}

// ─── CHEQUEO INACTIVIDAD ──────────────────────────────────────────────────────
async function checkInactividad() {
  const data = loadData();
  const now = Date.now();
  const guild = client.guilds.cache.first();
  if (!guild) return;

  const inactividadChannel = await client.channels.fetch(process.env.INACTIVIDAD_CHANNEL_ID).catch(() => null);
  if (!inactividadChannel) return;

  for (const [userId, userHistory] of Object.entries(data.history)) {
    const lastSession = userHistory.sessions[userHistory.sessions.length - 1];
    if (!lastSession) continue;
    const diasSinTurno = (now - lastSession.end) / (1000 * 60 * 60 * 24);
    if (diasSinTurno >= INACTIVIDAD_DIAS) {
      await inactividadChannel.send({
        content: `📋 <@${userId}> lleva **${Math.floor(diasSinTurno)} días** sin registrar turno. Revisar situación de actividad.`
      });
    }
  }
}

// ─── ROL ASPIRANTE AL UNIRSE ──────────────────────────────────────────────────
client.on('guildMemberAdd', async (member) => {
  try {
    const role = member.guild.roles.cache.get(process.env.ROLE_ID);
    if (!role) return;
    await member.roles.add(role);
    console.log(`Rol "Aspirante" asignado a ${member.user.tag}`);
  } catch (e) {
    console.error('Error al asignar rol:', e);
  }

  // DM de bienvenida
  try {
    await member.send([
      `👮 **Bienvenido/a a LSPD UnderGroundRP, ${member.user.username}**`,
      ``,
      `Has sido registrado como **Ciudadano**. Aquí tienes todo lo que necesitas saber:`,
      ``,
      `1️⃣ Lee el reglamento del servidor antes de cualquier acción.`,
      `2️⃣ Revisa los códigos radiales, son esenciales para operar en el departamento.`,
      `3️⃣ Si deseas unirte al LSPD, postula en el canal de postulaciones.`,
      `4️⃣ Una vez aceptado, recibirás el rango de **Aspirante** y comenzará tu formación.`,
      `5️⃣ Mantén una conducta respetuosa en todo momento dentro del servidor.`,
      ``,
      `Cualquier duda, contacta a un Instructor.`,
      `— Comandancia LSPD UnderGroundRP`,
    ].join('\n'));
  } catch {
    console.log(`No se pudo enviar DM a ${member.user.tag}`);
  }

  // Embed de bienvenida en canal
  try {
    const bienvenidaChannel = await client.channels.fetch(process.env.BIENVENIDA_CHANNEL_ID).catch(() => null);
    if (bienvenidaChannel) {
      const embed = new EmbedBuilder()
        .setTitle('👮 Nuevo Ciudadano – LSPD UnderGroundRP')
        .setDescription(`<@${member.id}> se ha unido al servidor.\n¡Bienvenido/a a **UnderGroundRP**!`)
        .setThumbnail(member.user.displayAvatarURL({ dynamic: true, size: 256 }))
        .addFields(
          { name: '👤 Usuario', value: member.user.tag, inline: true },
          { name: '🎖️ Rango Inicial', value: 'Ciudadano', inline: true },
          { name: '📅 Se unió', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true },
        )
        .setColor(0x1e90ff)
        .setFooter({ text: 'Comandancia LSPD – UnderGroundRP' })
        .setTimestamp();
      await bienvenidaChannel.send({ embeds: [embed] });
    }
  } catch (e) {
    console.error('Error enviando bienvenida:', e);
  }
});

// ─── SLASH COMMANDS ───────────────────────────────────────────────────────────
client.on('interactionCreate', async (interaction) => {
  const data = loadData();

  if (interaction.isChatInputCommand()) {
    const isStaff = interaction.member.roles.cache.has(process.env.STAFF_ROLE_ID);

    // /ascender
    if (interaction.commandName === 'ascender') {
      if (!isStaff) return interaction.reply({ content: '❌ Solo Comandancia puede ascender oficiales.', ephemeral: true });
      const target = interaction.options.getMember('oficial');
      const rangoActual = getRangoActual(target);
      const idxActual = rangoActual ? RANGOS.findIndex(r => r.id === rangoActual.id) : -1;
      if (idxActual >= RANGOS.length - 1) return interaction.reply({ content: '⚠️ Este oficial ya tiene el rango máximo.', ephemeral: true });
      const nuevoRango = RANGOS[idxActual + 1];
      if (rangoActual) await target.roles.remove(rangoActual.id).catch(() => {});
      await target.roles.add(nuevoRango.id);
      const embed = new EmbedBuilder()
        .setTitle('🎖️ Ascenso Oficial – LSPD')
        .setColor(0xffd700)
        .addFields(
          { name: 'Oficial', value: `<@${target.id}>`, inline: true },
          { name: 'Rango Anterior', value: rangoActual?.nombre || 'Sin rango', inline: true },
          { name: 'Nuevo Rango', value: nuevoRango.nombre, inline: true },
          { name: 'Ascendido por', value: `<@${interaction.user.id}>`, inline: true },
        )
        .setTimestamp();
      await interaction.reply({ embeds: [embed] });
      try { await target.send(`🎖️ Felicitaciones, has sido ascendido a **${nuevoRango.nombre}** en LSPD UnderGroundRP.`); } catch {}
    }

    // /ficha
    if (interaction.commandName === 'ficha') {
      const target = interaction.options.getMember('oficial') || interaction.member;
      const rangoActual = getRangoActual(target);
      const userHistory = data.history[target.id];
      const sanciones = data.sanciones[target.id] || [];
      const embed = new EmbedBuilder()
        .setTitle(`📁 Ficha Oficial – ${target.user.tag}`)
        .setColor(0x1e90ff)
        .setThumbnail(target.user.displayAvatarURL())
        .addFields(
          { name: '🎖️ Rango', value: rangoActual?.nombre || 'Sin rango', inline: true },
          { name: '⏱️ Horas Totales', value: userHistory ? formatDuration(userHistory.totalMs) : '0h 0m 0s', inline: true },
          { name: '📋 Turnos Registrados', value: userHistory ? `${userHistory.sessions.length}` : '0', inline: true },
          { name: '⚠️ Sanciones', value: `${sanciones.length}`, inline: true },
        )
        .setTimestamp();
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    // /sancionar
    if (interaction.commandName === 'sancionar') {
      if (!isStaff) return interaction.reply({ content: '❌ Solo Comandancia puede sancionar oficiales.', ephemeral: true });
      const target = interaction.options.getMember('oficial');
      const motivo = interaction.options.getString('motivo');
      if (!data.sanciones[target.id]) data.sanciones[target.id] = [];
      data.sanciones[target.id].push({ motivo, fecha: Date.now(), por: interaction.user.tag });
      saveData(data);
      const total = data.sanciones[target.id].length;

      // Avisar al staff si llega a 3 sanciones
      if (total >= 3) {
        const inactividadChannel = await client.channels.fetch(process.env.INACTIVIDAD_CHANNEL_ID).catch(() => null);
        if (inactividadChannel) {
          await inactividadChannel.send(`⚠️ <@&${process.env.STAFF_ROLE_ID}> El oficial <@${target.id}> ha acumulado **${total} sanciones**. Se recomienda revisar su situación.`);
        }
      }
      const embed = new EmbedBuilder()
        .setTitle('⚠️ Sanción Aplicada – LSPD')
        .setColor(0xff4500)
        .addFields(
          { name: 'Oficial', value: `<@${target.id}>`, inline: true },
          { name: 'Motivo', value: motivo },
          { name: 'Aplicada por', value: `<@${interaction.user.id}>`, inline: true },
          { name: 'Total sanciones', value: `${total}`, inline: true },
        )
        .setTimestamp();
      await interaction.reply({ embeds: [embed] });
      try { await target.send(`⚠️ Has recibido una sanción en LSPD UnderGroundRP.\n**Motivo:** ${motivo}`); } catch {}
    }

    // /buscar
    if (interaction.commandName === 'buscar') {
      if (!isStaff) return interaction.reply({ content: '❌ Solo Comandancia puede usar este comando.', ephemeral: true });
      const target = interaction.options.getMember('oficial');
      const userHistory = data.history[target.id];
      const sanciones = data.sanciones[target.id] || [];
      const rangoActual = getRangoActual(target);
      const ultimosTurnos = userHistory?.sessions.slice(-5).reverse().map(s =>
        `• ${new Date(s.start).toLocaleDateString('es-CL')} — ${formatDuration(s.duration)}`
      ).join('\n') || 'Sin turnos registrados';
      const ultimasSanciones = sanciones.slice(-3).reverse().map(s =>
        `• ${new Date(s.fecha).toLocaleDateString('es-CL')} — ${s.motivo} (por ${s.por})`
      ).join('\n') || 'Sin sanciones';
      const embed = new EmbedBuilder()
        .setTitle(`🔍 Historial – ${target.user.tag}`)
        .setColor(0x9b59b6)
        .setThumbnail(target.user.displayAvatarURL())
        .addFields(
          { name: '🎖️ Rango', value: rangoActual?.nombre || 'Sin rango', inline: true },
          { name: '⏱️ Horas Totales', value: userHistory ? formatDuration(userHistory.totalMs) : '0h 0m 0s', inline: true },
          { name: '📋 Últimos 5 Turnos', value: ultimosTurnos },
          { name: '⚠️ Últimas Sanciones', value: ultimasSanciones },
        )
        .setTimestamp();
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    // /resetear_horas
    if (interaction.commandName === 'resetear_horas') {
      if (!isStaff) return interaction.reply({ content: '❌ Solo Comandancia puede resetear horas.', ephemeral: true });
      data.history = {};
      data.sessions = {};
      saveData(data);
      return interaction.reply({ content: '✅ Horas de todos los oficiales reseteadas.', ephemeral: true });
    }

    // /baja
    if (interaction.commandName === 'baja') {
      if (!isStaff) return interaction.reply({ content: '❌ Solo Comandancia puede dar de baja a oficiales.', ephemeral: true });
      const target = interaction.options.getMember('oficial');
      const motivo = interaction.options.getString('motivo');
      const rolesAQuitar = RANGOS.map(r => r.id).filter(id => target.roles.cache.has(id));
      for (const roleId of rolesAQuitar) await target.roles.remove(roleId).catch(() => {});
      const embed = new EmbedBuilder()
        .setTitle('🚨 Baja Registrada – LSPD')
        .setColor(0xff0000)
        .addFields(
          { name: 'Oficial', value: `<@${target.id}>`, inline: true },
          { name: 'Motivo', value: motivo },
          { name: 'Procesado por', value: `<@${interaction.user.id}>`, inline: true },
        )
        .setTimestamp();
      await interaction.reply({ embeds: [embed] });
      try { await target.send(`🚨 Has sido dado de baja en LSPD UnderGroundRP.\n**Motivo:** ${motivo}`); } catch {}
    }

    // /solicitar_ascenso
    if (interaction.commandName === 'solicitar_ascenso') {
      const rangoActual = getRangoActual(interaction.member);
      const idxActual = rangoActual ? RANGOS.findIndex(r => r.id === rangoActual.id) : -1;
      const siguienteRango = idxActual >= 0 && idxActual < RANGOS.length - 1 ? RANGOS[idxActual + 1] : null;
      if (!siguienteRango) return interaction.reply({ content: '⚠️ Ya tienes el rango máximo o no tienes rango asignado.', ephemeral: true });
      const ascensoChannel = await client.channels.fetch(process.env.ASCENSO_CHANNEL_ID).catch(() => null);
      if (!ascensoChannel) return interaction.reply({ content: '❌ Canal de solicitudes no encontrado.', ephemeral: true });
      const embed = new EmbedBuilder()
        .setTitle('📋 Solicitud de Ascenso')
        .setColor(0xffd700)
        .setThumbnail(interaction.user.displayAvatarURL())
        .addFields(
          { name: 'Oficial', value: `<@${interaction.user.id}>`, inline: true },
          { name: 'Rango Actual', value: rangoActual?.nombre || 'Sin rango', inline: true },
          { name: 'Rango Solicitado', value: siguienteRango.nombre, inline: true },
        )
        .setTimestamp();
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`aprobar_ascenso_${interaction.user.id}`).setLabel('✅ Aprobar').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`rechazar_ascenso_${interaction.user.id}`).setLabel('❌ Rechazar').setStyle(ButtonStyle.Danger),
      );
      await ascensoChannel.send({ embeds: [embed], components: [row] });
      return interaction.reply({ content: '✅ Solicitud de ascenso enviada a Comandancia.', ephemeral: true });
    }

    // /solicitar_vacaciones
    if (interaction.commandName === 'solicitar_vacaciones') {
      const motivo = interaction.options.getString('motivo');
      const vacacionesChannel = await client.channels.fetch(process.env.VACACIONES_CHANNEL_ID).catch(() => null);
      if (!vacacionesChannel) return interaction.reply({ content: '❌ Canal de solicitudes no encontrado.', ephemeral: true });
      const embed = new EmbedBuilder()
        .setTitle('🏖️ Solicitud de Vacaciones / Permiso')
        .setColor(0x00bfff)
        .setThumbnail(interaction.user.displayAvatarURL())
        .addFields(
          { name: 'Oficial', value: `<@${interaction.user.id}>`, inline: true },
          { name: 'Rango', value: getRangoActual(interaction.member)?.nombre || 'Sin rango', inline: true },
          { name: 'Motivo / Duración', value: motivo },
        )
        .setTimestamp();
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`aprobar_vacaciones_${interaction.user.id}`).setLabel('✅ Aprobar').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`rechazar_vacaciones_${interaction.user.id}`).setLabel('❌ Rechazar').setStyle(ButtonStyle.Danger),
      );
      await vacacionesChannel.send({ embeds: [embed], components: [row] });
      return interaction.reply({ content: '✅ Solicitud de vacaciones enviada a Comandancia.', ephemeral: true });
    }

    // /estadisticas
    if (interaction.commandName === 'estadisticas') {
      const guild = interaction.guild;
      const porRango = RANGOS.map(r => {
        const count = guild.members.cache.filter(m => m.roles.cache.has(r.id)).size;
        return count > 0 ? `${r.nombre}: **${count}**` : null;
      }).filter(Boolean).join('\n');
      const totalHoras = Object.values(data.history).reduce((acc, u) => acc + u.totalMs, 0);
      const embed = new EmbedBuilder()
        .setTitle('📊 Estadísticas – LSPD UnderGroundRP')
        .setColor(0x1e90ff)
        .addFields(
          { name: '👮 Oficiales por Rango', value: porRango || 'Sin datos' },
          { name: '⏱️ Horas Totales Acumuladas', value: formatDuration(totalHoras) },
          { name: '📋 Turnos Registrados', value: `${Object.values(data.history).reduce((acc, u) => acc + u.sessions.length, 0)}` },
        )
        .setTimestamp();
      return interaction.reply({ embeds: [embed] });
    }
    if (interaction.commandName === 'test_alertas') {
      if (!isStaff) return interaction.reply({ content: '❌ Solo Comandancia puede usar este comando.', ephemeral: true });
      await interaction.reply({ content: '🔔 Enviando alertas de prueba...', ephemeral: true });
      const inactividadChannel = await client.channels.fetch(process.env.INACTIVIDAD_CHANNEL_ID).catch(() => null);
      if (inactividadChannel) {
        await inactividadChannel.send(`⚠️ **[PRUEBA]** <@${interaction.user.id}> lleva más de **30 minutos** con el turno abierto sin cerrarlo. Staff o Alto Mando puede cerrarlo con \`/cerrar_turno\`.`);
        await inactividadChannel.send(`📋 **[PRUEBA]** <@${interaction.user.id}> lleva **5 días** sin registrar turno. Revisar situación de actividad.`);
      }
    }
    if (interaction.commandName === 'cerrar_turno') {
      if (!isStaff) return interaction.reply({ content: '❌ Solo Comandancia o Alto Mando puede cerrar turnos.', ephemeral: true });
      const target = interaction.options.getMember('oficial');
      const session = data.sessions[target.id];
      if (!session) return interaction.reply({ content: '⚠️ Este oficial no tiene un turno activo.', ephemeral: true });
      const duration = Date.now() - session.start;
      if (!data.history[target.id]) data.history[target.id] = { username: target.user.tag, totalMs: 0, sessions: [] };
      data.history[target.id].totalMs += duration;
      data.history[target.id].sessions.push({ start: session.start, end: Date.now(), duration });
      delete data.sessions[target.id];
      saveData(data);
      await interaction.reply({ content: `✅ Turno de <@${target.id}> cerrado. Duración: **${formatDuration(duration)}**` });
      try { await target.send(`🔴 Tu turno fue cerrado por Comandancia. Duración: **${formatDuration(duration)}**`); } catch {}
    }
  }

  // ─── BOTONES ─────────────────────────────────────────────────────────────────
  if (interaction.isButton()) {
    const userId = interaction.user.id;
    const now = Date.now();

    if (interaction.customId === 'iniciar_turno') {
      if (data.sessions[userId]) return interaction.reply({ content: '⚠️ Ya tienes un turno activo.', ephemeral: true });
      data.sessions[userId] = { start: now, username: interaction.user.tag };
      saveData(data);
      // Radio automática
      const radioChannel = await client.channels.fetch(process.env.RADIO_CHANNEL_ID).catch(() => null);
      if (radioChannel) await radioChannel.send(`🟢 **${interaction.member.nickname || interaction.user.username}** ha iniciado servicio. <t:${Math.floor(now/1000)}:T>`);
      updateActivosMessage();
      return interaction.reply({ content: `✅ Turno iniciado a las <t:${Math.floor(now / 1000)}:T>.`, ephemeral: true });
    }

    if (interaction.customId === 'finalizar_turno') {
      const session = data.sessions[userId];
      if (!session) return interaction.reply({ content: '⚠️ No tienes un turno activo.', ephemeral: true });
      const duration = now - session.start;
      if (!data.history[userId]) data.history[userId] = { username: interaction.user.tag, totalMs: 0, sessions: [] };
      data.history[userId].totalMs += duration;
      data.history[userId].sessions.push({ start: session.start, end: now, duration });
      delete data.sessions[userId];
      saveData(data);
      // Radio automática
      const radioChannel2 = await client.channels.fetch(process.env.RADIO_CHANNEL_ID).catch(() => null);
      if (radioChannel2) await radioChannel2.send(`🔴 **${interaction.member.nickname || interaction.user.username}** ha finalizado servicio. Duración: **${formatDuration(duration)}**`);
      updateActivosMessage();

      // Recordatorio de bitácora en 30 minutos
      const bitacoraCount = data.history[userId].sessions.length;
      setTimeout(async () => {
        const freshData = loadData();
        const sesionesActuales = freshData.history[userId]?.sessions.length || 0;
        // Si no registró nueva bitácora (mismo conteo), mandar DM
        if (sesionesActuales === bitacoraCount) {
          try {
            const user = await client.users.fetch(userId);
            await user.send(`📋 Recuerda registrar tu **bitácora operativa** del turno que acabas de cerrar. Tienes pendiente el registro en el canal de bitácoras.`);
          } catch {}
        }
      }, 90 * 60 * 1000);
      return interaction.reply({ content: `🔴 Turno finalizado. Duración: **${formatDuration(duration)}**`, ephemeral: true });
    }

    if (interaction.customId === 'ver_horas_staff') {
      const member = await interaction.guild.members.fetch(userId);
      if (!member.roles.cache.has(process.env.STAFF_ROLE_ID)) return interaction.reply({ content: '❌ Solo Comandancia puede ver este resumen.', ephemeral: true });
      const history = data.history;
      if (Object.keys(history).length === 0) return interaction.reply({ content: 'No hay horas registradas.', ephemeral: true });
      const lines = Object.values(history).sort((a, b) => b.totalMs - a.totalMs).map(u => `👤 **${u.username}** — ${formatDuration(u.totalMs)}`);
      const embed = new EmbedBuilder().setTitle('📊 Resumen de Horas - LSPD').setDescription(lines.join('\n')).setColor(0xffd700).setTimestamp();
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (interaction.customId === 'nueva_bitacora' || interaction.customId === 'nueva_bitacora_firma') {
      const firmaAuto = interaction.customId === 'nueva_bitacora_firma';
      const rangoActual = getRangoActual(interaction.member);
      const nickParts = (interaction.member.nickname || interaction.user.username).split(' ');
      const apellido = nickParts[nickParts.length - 1];

      // Tomar último turno del oficial
      const userHistory = data.history[interaction.user.id];
      const lastSession = userHistory?.sessions?.[userHistory.sessions.length - 1];
      const horaInicio = lastSession ? new Date(lastSession.start).toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' }) : '';
      const horaCierre = lastSession ? new Date(lastSession.end).toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' }) : '';

      // Determinar turno según horas
      let nombreTurno = 'Turno';
      if (lastSession) {
        const hInicio = new Date(lastSession.start).getHours();
        const hCierre = new Date(lastSession.end).getHours();
        const esDiurnoInicio = hInicio >= 6 && hInicio < 18;
        const esDiurnoFin = hCierre >= 6 && hCierre < 18;
        if (esDiurnoInicio && esDiurnoFin) nombreTurno = 'Diurno';
        else if (!esDiurnoInicio && !esDiurnoFin) nombreTurno = 'Vespertino';
        else nombreTurno = 'Completo';
      }

      const turnoDefault = horaInicio && horaCierre ? `${nombreTurno} | ${horaInicio} | ${horaCierre}` : '';

      const modal = new ModalBuilder().setCustomId('modal_bitacora').setTitle('Bitácora Operativa LSPD');

      const turnoField = new TextInputBuilder().setCustomId('turno').setLabel('Turno / Hora Inicio / Hora Cierre').setStyle(TextInputStyle.Short).setPlaceholder('Ej: Vespertino | 18:00 | 20:00').setRequired(true);
      if (turnoDefault) turnoField.setValue(turnoDefault);

      const zonaField = new TextInputBuilder().setCustomId('zona').setLabel('Zona de Cobertura').setStyle(TextInputStyle.Short).setRequired(true).setValue('Zona Sur');

      const nombreCompleto = interaction.member.nickname || interaction.user.username;
      const unidadField = new TextInputBuilder().setCustomId('unidad').setLabel('Unidad Asignada | Nombre del Oficial').setStyle(TextInputStyle.Short).setPlaceholder('Ej: U-23 | León Moretti').setRequired(true).setValue(`U-00 | ${nombreCompleto}`);

      const obsField = new TextInputBuilder().setCustomId('observaciones').setLabel('Observaciones y Firma').setStyle(TextInputStyle.Paragraph).setPlaceholder('Observaciones...\nFirma: Sgto. León Moretti').setRequired(true);
      if (firmaAuto) obsField.setValue(`Sin observaciones en el turno.\nFirma: ${rangoActual?.nombre || ''} ${apellido}`);

      modal.addComponents(
        new ActionRowBuilder().addComponents(turnoField),
        new ActionRowBuilder().addComponents(unidadField),
        new ActionRowBuilder().addComponents(zonaField),
        new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('actuaciones').setLabel('Actuaciones Registradas').setStyle(TextInputStyle.Paragraph).setPlaceholder('18:15 – Patrullaje...\n18:42 – Detención...').setRequired(true)),
        new ActionRowBuilder().addComponents(obsField),
      );
      return interaction.showModal(modal);
    }

    // Botón iniciar postulación → modal paso 1
    if (interaction.customId === 'btn_postular') {
      const modal = new ModalBuilder().setCustomId('modal_postulacion_1').setTitle('Postulación LSPD – Paso 1 de 2');
      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('p_nombre').setLabel('Nombre del personaje y edad').setStyle(TextInputStyle.Short).setPlaceholder('Ej: Juan Pérez, 28 años').setRequired(true)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('p_origen').setLabel('¿De dónde eres? (país/ciudad)').setStyle(TextInputStyle.Short).setPlaceholder('Ej: Chile, Santiago').setRequired(true)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('p_experiencia').setLabel('Experiencia previa en roleplay policial').setStyle(TextInputStyle.Paragraph).setPlaceholder('Describe tu experiencia en otros servidores o si es tu primera vez').setRequired(true)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('p_motivo').setLabel('¿Por qué quieres unirte al LSPD?').setStyle(TextInputStyle.Paragraph).setRequired(true)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('p_horario').setLabel('Disponibilidad horaria').setStyle(TextInputStyle.Short).setPlaceholder('Ej: Lunes a viernes 18:00 - 22:00').setRequired(true)
        ),
      );
      return interaction.showModal(modal);
    }

    // Botón paso 2 de postulación
    if (interaction.customId.startsWith('btn_postulacion_paso2_')) {
      const userId = interaction.customId.replace('btn_postulacion_paso2_', '');
      if (interaction.user.id !== userId) return interaction.reply({ content: '❌ Este botón no es tuyo.', ephemeral: true });
      const modal = new ModalBuilder().setCustomId(`modal_postulacion_2_${userId}`).setTitle('Postulación LSPD – Paso 2 de 2');
      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('p_microfono').setLabel('¿Tienes micrófono?').setStyle(TextInputStyle.Short).setPlaceholder('Sí / No').setRequired(true)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('p_codigos').setLabel('¿Conoces los códigos 10?').setStyle(TextInputStyle.Short).setPlaceholder('Sí / No / Algunos').setRequired(true)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('p_ban').setLabel('¿Has sido baneado? ¿Por qué?').setStyle(TextInputStyle.Paragraph).setPlaceholder('Si no, escribe "No"').setRequired(true)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('p_orden').setLabel('¿Qué harías ante una orden incorrecta?').setStyle(TextInputStyle.Paragraph).setRequired(true)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('p_extra').setLabel('Cuéntanos algo sobre ti').setStyle(TextInputStyle.Paragraph).setRequired(true)
        ),
      );
      return interaction.showModal(modal);
    }

    // Botón solicitar ascenso
    if (interaction.customId === 'btn_solicitar_ascenso') {
      const rangoActual = getRangoActual(interaction.member);
      const idxActual = rangoActual ? RANGOS.findIndex(r => r.id === rangoActual.id) : -1;
      const siguienteRango = idxActual >= 0 && idxActual < RANGOS.length - 1 ? RANGOS[idxActual + 1] : null;
      if (!siguienteRango) return interaction.reply({ content: '⚠️ Ya tienes el rango máximo o no tienes rango asignado.', ephemeral: true });
      const ascensoChannel = await client.channels.fetch(process.env.ASCENSO_CHANNEL_ID).catch(() => null);
      const embed = new EmbedBuilder()
        .setTitle('📋 Solicitud de Ascenso')
        .setColor(0xffd700)
        .setThumbnail(interaction.user.displayAvatarURL())
        .addFields(
          { name: 'Oficial', value: `<@${interaction.user.id}>`, inline: true },
          { name: 'Rango Actual', value: rangoActual?.nombre || 'Sin rango', inline: true },
          { name: 'Rango Solicitado', value: siguienteRango.nombre, inline: true },
        )
        .setTimestamp();
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`aprobar_ascenso_${interaction.user.id}`).setLabel('✅ Aprobar').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`rechazar_ascenso_${interaction.user.id}`).setLabel('❌ Rechazar').setStyle(ButtonStyle.Danger),
      );
      await ascensoChannel.send({ embeds: [embed], components: [row] });
      return interaction.reply({ content: '✅ Solicitud enviada a Comandancia.', ephemeral: true });
    }

    // Botón solicitar vacaciones → modal
    if (interaction.customId === 'btn_solicitar_vacaciones') {
      const modal = new ModalBuilder().setCustomId('modal_vacaciones').setTitle('Solicitud de Vacaciones / Permiso');
      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('motivo_vacaciones').setLabel('Motivo o duración del permiso').setStyle(TextInputStyle.Paragraph).setRequired(true)
        )
      );
      return interaction.showModal(modal);
    }

    // Botón estadísticas
    if (interaction.customId === 'btn_estadisticas') {
      const isStaffBtn = interaction.member.roles.cache.has(process.env.STAFF_ROLE_ID);
      const isAltoMando = interaction.member.roles.cache.has('1485435090426400901') || interaction.member.roles.cache.has('1485435169136447539');
      if (!isStaffBtn && !isAltoMando) return interaction.reply({ content: '❌ Solo Staff o Alto Mando puede ver estadísticas.', ephemeral: true });
      const porRango = RANGOS.map(r => {
        const count = interaction.guild.members.cache.filter(m => m.roles.cache.has(r.id)).size;
        return count > 0 ? `${r.nombre}: **${count}**` : null;
      }).filter(Boolean).join('\n');
      const totalHoras = Object.values(data.history).reduce((acc, u) => acc + u.totalMs, 0);
      const embed = new EmbedBuilder()
        .setTitle('📊 Estadísticas – LSPD UnderGroundRP')
        .setColor(0x1e90ff)
        .addFields(
          { name: '👮 Oficiales por Rango', value: porRango || 'Sin datos' },
          { name: '⏱️ Horas Totales Acumuladas', value: formatDuration(totalHoras) },
          { name: '📋 Turnos Registrados', value: `${Object.values(data.history).reduce((acc, u) => acc + u.sessions.length, 0)}` },
        )
        .setTimestamp();
      return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    // Botón dar de baja → modal
    if (interaction.customId === 'btn_baja') {
      const isStaffBtn = interaction.member.roles.cache.has(process.env.STAFF_ROLE_ID);
      const isAltoMando = interaction.member.roles.cache.has('1485435090426400901') || interaction.member.roles.cache.has('1485435169136447539');
      if (!isStaffBtn && !isAltoMando) return interaction.reply({ content: '❌ Solo Staff, Subjefe o Jefe de Policía puede dar de baja.', ephemeral: true });
      const modal = new ModalBuilder().setCustomId('modal_baja').setTitle('Dar de Baja – LSPD');
      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('baja_user_id').setLabel('ID del oficial a dar de baja').setStyle(TextInputStyle.Short).setRequired(true)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId('baja_motivo').setLabel('Motivo de la baja').setStyle(TextInputStyle.Paragraph).setRequired(true)
        ),
      );
      return interaction.showModal(modal);
    }

    // Aprobar/rechazar postulación
    if (interaction.customId.startsWith('aprobar_postulacion_') || interaction.customId.startsWith('rechazar_postulacion_')) {
      const hasRole = interaction.member.roles.cache.has('1485435169136447539'); // Solo Jefe de Policía
      if (!hasRole) return interaction.reply({ content: '❌ Solo el Jefe de Policía puede aprobar o rechazar postulaciones.', ephemeral: true });
      if (!hasRole) return interaction.reply({ content: '❌ No tienes permiso para revisar postulaciones.', ephemeral: true });
      const targetId = interaction.customId.split('_').pop();
      const target = await interaction.guild.members.fetch(targetId).catch(() => null);
      const aprobado = interaction.customId.startsWith('aprobar_postulacion_');
      if (aprobado && target) {
        const role = interaction.guild.roles.cache.get('1485416321473839155'); // Aspirante
        if (role && !target.roles.cache.has(role.id)) await target.roles.add(role).catch(() => {});
        try { await target.send(`✅ Tu postulación al **LSPD UnderGroundRP** fue **aprobada**. Bienvenido/a, eres ahora **Aspirante**. Espera instrucciones del Instructor.`); } catch {}
      } else if (target) {
        try { await target.send(`❌ Tu postulación al **LSPD UnderGroundRP** fue **rechazada**. Puedes volver a postular más adelante.`); } catch {}
      }
      const updatedEmbed = EmbedBuilder.from(interaction.message.embeds[0])
        .setColor(aprobado ? 0x00ff00 : 0xff0000)
        .setFooter({ text: `${aprobado ? '✅ Aprobado' : '❌ Rechazado'} por Comandancia LSPD – Alto Mando` });
      await interaction.update({ embeds: [updatedEmbed], components: [] });
    }

    // Aprobar/rechazar ascenso
    if (interaction.customId.startsWith('aprobar_ascenso_') || interaction.customId.startsWith('rechazar_ascenso_')) {
      const isStaffBtn = interaction.member.roles.cache.has(process.env.STAFF_ROLE_ID);
      if (!isStaffBtn) return interaction.reply({ content: '❌ Solo Comandancia puede aprobar solicitudes.', ephemeral: true });
      const targetId = interaction.customId.split('_').pop();
      const target = await interaction.guild.members.fetch(targetId).catch(() => null);
      const aprobado = interaction.customId.startsWith('aprobar_ascenso_');
      if (aprobado && target) {
        const rangoActual = getRangoActual(target);
        const idxActual = rangoActual ? RANGOS.findIndex(r => r.id === rangoActual.id) : -1;
        const nuevoRango = RANGOS[idxActual + 1];
        if (nuevoRango) {
          if (rangoActual) await target.roles.remove(rangoActual.id).catch(() => {});
          await target.roles.add(nuevoRango.id);
          try { await target.send(`🎖️ Tu solicitud de ascenso fue **aprobada** por Comandancia. Nuevo rango: **${nuevoRango.nombre}**`); } catch {}
        }
      } else if (target) {
        try { await target.send(`❌ Tu solicitud de ascenso fue **rechazada** por Comandancia.`); } catch {}
      }
      const updatedEmbed = EmbedBuilder.from(interaction.message.embeds[0])
        .setColor(aprobado ? 0x00ff00 : 0xff0000)
        .setFooter({ text: `${aprobado ? '✅ Aprobado' : '❌ Rechazado'} por Comandancia LSPD – Alto Mando` });
      await interaction.update({ embeds: [updatedEmbed], components: [] });
    }

    // Aprobar/rechazar vacaciones
    if (interaction.customId.startsWith('aprobar_vacaciones_') || interaction.customId.startsWith('rechazar_vacaciones_')) {
      const isStaffBtn = interaction.member.roles.cache.has(process.env.STAFF_ROLE_ID);
      if (!isStaffBtn) return interaction.reply({ content: '❌ Solo Comandancia puede aprobar solicitudes.', ephemeral: true });
      const targetId = interaction.customId.split('_').pop();
      const target = await interaction.guild.members.fetch(targetId).catch(() => null);
      const aprobado = interaction.customId.startsWith('aprobar_vacaciones_');
      if (target) {
        try { await target.send(`🏖️ Tu solicitud de vacaciones fue **${aprobado ? 'aprobada ✅' : 'rechazada ❌'}** por Comandancia.`); } catch {}
      }
      const updatedEmbed = EmbedBuilder.from(interaction.message.embeds[0])
        .setColor(aprobado ? 0x00ff00 : 0xff0000)
        .setFooter({ text: `${aprobado ? '✅ Aprobado' : '❌ Rechazado'} por Comandancia LSPD – Alto Mando` });
      await interaction.update({ embeds: [updatedEmbed], components: [] });
    }

    if (interaction.customId.startsWith('adjuntar_fotos_')) {      const bitacoraMessageId = interaction.customId.replace('adjuntar_fotos_', '');
      data.pendingBitacora[userId] = { channelId: interaction.channelId, messageId: bitacoraMessageId };
      saveData(data);
      return interaction.reply({ content: '📸 Envía las fotos ahora. Escribe `listo` cuando termines.', ephemeral: true });
    }
  }

  // Modal postulación paso 1
  if (interaction.isModalSubmit() && interaction.customId === 'modal_postulacion_1') {
    const nombre = interaction.fields.getTextInputValue('p_nombre');
    const origen = interaction.fields.getTextInputValue('p_origen');
    const experiencia = interaction.fields.getTextInputValue('p_experiencia');
    const motivo = interaction.fields.getTextInputValue('p_motivo');
    const horario = interaction.fields.getTextInputValue('p_horario');

    // Guardar paso 1 temporalmente
    data.pendingBitacora[`post_${interaction.user.id}`] = { nombre, origen, experiencia, motivo, horario };
    saveData(data);

    await interaction.reply({
      content: '✅ Paso 1 completado. Presiona el botón para continuar con el paso 2.',
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`btn_postulacion_paso2_${interaction.user.id}`).setLabel('➡️ Continuar Paso 2').setStyle(ButtonStyle.Primary)
      )],
      ephemeral: true
    });
  }

  // Modal postulación paso 2
  if (interaction.isModalSubmit() && interaction.customId.startsWith('modal_postulacion_2_')) {
    const userId = interaction.customId.replace('modal_postulacion_2_', '');
    const paso1 = data.pendingBitacora[`post_${userId}`];
    if (!paso1) return interaction.reply({ content: '❌ No se encontró el paso 1. Vuelve a postular.', ephemeral: true });

    const microfono = interaction.fields.getTextInputValue('p_microfono');
    const codigos = interaction.fields.getTextInputValue('p_codigos');
    const ban = interaction.fields.getTextInputValue('p_ban');
    const orden = interaction.fields.getTextInputValue('p_orden');
    const extra = interaction.fields.getTextInputValue('p_extra');

    delete data.pendingBitacora[`post_${userId}`];
    saveData(data);

    const embed = new EmbedBuilder()
      .setTitle('📋 Nueva Postulación – LSPD UnderGroundRP')
      .setColor(0x1e90ff)
      .setThumbnail(interaction.user.displayAvatarURL())
      .addFields(
        { name: '👤 Discord', value: `<@${interaction.user.id}>`, inline: true },
        { name: '🧑 Nombre / Edad', value: paso1.nombre, inline: true },
        { name: '🌍 Origen', value: paso1.origen, inline: true },
        { name: '🎖️ Experiencia Previa', value: paso1.experiencia },
        { name: '❓ ¿Por qué el LSPD?', value: paso1.motivo },
        { name: '🕐 Disponibilidad', value: paso1.horario, inline: true },
        { name: '🎙️ Micrófono', value: microfono, inline: true },
        { name: '📻 Códigos 10', value: codigos, inline: true },
        { name: '🚫 ¿Baneado?', value: ban },
        { name: '⚖️ Orden incorrecta', value: orden },
        { name: '💬 Sobre mí', value: extra },
      )
      .setFooter({ text: `Postulación enviada por ${interaction.user.tag}` })
      .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`aprobar_postulacion_${userId}`).setLabel('✅ Aprobar').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`rechazar_postulacion_${userId}`).setLabel('❌ Rechazar').setStyle(ButtonStyle.Danger),
    );

    const postChannel = await client.channels.fetch(process.env.POSTULACION_CHANNEL_ID).catch(() => null);
    if (postChannel) await postChannel.send({ content: `<@&${process.env.POSTULACION_STAFF_ROLE_ID}>`, embeds: [embed], components: [row] });

    return interaction.reply({ content: '✅ Postulación enviada. Te notificaremos cuando sea revisada.', ephemeral: true });
  }

  // Modal vacaciones
  if (interaction.isModalSubmit() && interaction.customId === 'modal_vacaciones') {
    const motivo = interaction.fields.getTextInputValue('motivo_vacaciones');
    const vacacionesChannel = await client.channels.fetch(process.env.VACACIONES_CHANNEL_ID).catch(() => null);
    const embed = new EmbedBuilder()
      .setTitle('🏖️ Solicitud de Vacaciones / Permiso')
      .setColor(0x00bfff)
      .setThumbnail(interaction.user.displayAvatarURL())
      .addFields(
        { name: 'Oficial', value: `<@${interaction.user.id}>`, inline: true },
        { name: 'Rango', value: getRangoActual(interaction.member)?.nombre || 'Sin rango', inline: true },
        { name: 'Motivo / Duración', value: motivo },
      )
      .setTimestamp();
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`aprobar_vacaciones_${interaction.user.id}`).setLabel('✅ Aprobar').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`rechazar_vacaciones_${interaction.user.id}`).setLabel('❌ Rechazar').setStyle(ButtonStyle.Danger),
    );
    await vacacionesChannel.send({ embeds: [embed], components: [row] });
    return interaction.reply({ content: '✅ Solicitud de vacaciones enviada a Comandancia.', ephemeral: true });
  }

  // Modal baja
  if (interaction.isModalSubmit() && interaction.customId === 'modal_baja') {
    const targetId = interaction.fields.getTextInputValue('baja_user_id').trim();
    const motivo = interaction.fields.getTextInputValue('baja_motivo');
    const target = await interaction.guild.members.fetch(targetId).catch(() => null);
    if (!target) return interaction.reply({ content: '❌ No se encontró al oficial con ese ID.', ephemeral: true });
    const rolesAQuitar = RANGOS.map(r => r.id).filter(id => target.roles.cache.has(id));
    for (const roleId of rolesAQuitar) await target.roles.remove(roleId).catch(() => {});
    const embed = new EmbedBuilder()
      .setTitle('🚨 Baja Registrada – LSPD')
      .setColor(0xff0000)
      .addFields(
        { name: 'Oficial', value: `<@${target.id}>`, inline: true },
        { name: 'Motivo', value: motivo },
        { name: 'Procesado por', value: `<@${interaction.user.id}>`, inline: true },
      )
      .setTimestamp();
    await interaction.reply({ embeds: [embed] });
    try { await target.send(`🚨 Has sido dado de baja en LSPD UnderGroundRP.\n**Motivo:** ${motivo}`); } catch {}
  }

  // ─── MODAL BITÁCORA ───────────────────────────────────────────────────────────
  if (interaction.isModalSubmit() && interaction.customId === 'modal_bitacora') {
    const turnoRaw = interaction.fields.getTextInputValue('turno').split('|');
    const unidadRaw = interaction.fields.getTextInputValue('unidad').split('|');
    const zona = interaction.fields.getTextInputValue('zona');
    const actuaciones = interaction.fields.getTextInputValue('actuaciones');
    const observaciones = interaction.fields.getTextInputValue('observaciones');

    const turno = turnoRaw[0]?.trim() || 'N/A';
    const horaInicio = turnoRaw[1]?.trim() || 'N/A';
    const horaCierre = turnoRaw[2]?.trim() || 'N/A';
    const unidad = unidadRaw[0]?.trim() || 'N/A';
    const supervisor = unidadRaw[1]?.trim() || interaction.user.tag;
    const fecha = new Date().toLocaleDateString('es-CL');

    const embed = new EmbedBuilder()
      .setTitle('📋 BITÁCORA OPERATIVA – COMANDANCIA LSPD UNDERGROUNDRP')
      .setColor(0x1a1a2e)
      .addFields(
        { name: '📅 Fecha', value: fecha, inline: true },
        { name: '🕐 Turno', value: turno, inline: true },
        { name: '⏰ Hora Inicio', value: horaInicio, inline: true },
        { name: '⏰ Hora Cierre', value: horaCierre, inline: true },
        { name: '🚔 Unidad Asignada', value: unidad, inline: true },
        { name: '👮 Oficial Supervisor', value: supervisor, inline: true },
        { name: '🗺️ Zona de Cobertura', value: zona },
        { name: '📝 Actuaciones Registradas', value: actuaciones },
        { name: '📌 Observaciones y Firma', value: observaciones },
      )
      .setFooter({ text: `Registrado por ${interaction.user.tag}` })
      .setTimestamp();

    await interaction.reply({ content: '✅ Bitácora registrada.', ephemeral: true });

    const sent = await interaction.channel.send({ embeds: [embed], components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`adjuntar_fotos_PLACEHOLDER`).setLabel('📸 Adjuntar Fotos de Detenidos (opcional)').setStyle(ButtonStyle.Secondary)
      )
    ]});

    await sent.edit({ components: [
      new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`adjuntar_fotos_${sent.id}`).setLabel('📸 Adjuntar Fotos de Detenidos (opcional)').setStyle(ButtonStyle.Secondary)
      )
    ]});

    try {
      const archivoChannel = await client.channels.fetch(process.env.ARCHIVO_CHANNEL_ID);
      await archivoChannel.send({ embeds: [embed] });
      console.log('Bitácora copiada al canal de archivo.');
    } catch (e) {
      console.error('Error al copiar al canal de archivo:', e.message);
    }
  }
});

// ─── FOTOS ────────────────────────────────────────────────────────────────────
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  const data = loadData();
  const userId = message.author.id;
  const pending = data.pendingBitacora[userId];
  if (!pending) return;

  if (message.content.toLowerCase() === 'listo') {
    delete data.pendingBitacora[userId];
    saveData(data);
    const reply = await message.reply('✅ Fotos adjuntadas a tu bitácora.');
    setTimeout(() => reply.delete().catch(() => {}), 5000);
    await message.delete().catch(() => {});
    return;
  }

  if (message.attachments.size > 0 && message.channelId === pending.channelId) {
    try {
      const channel = await client.channels.fetch(pending.channelId);
      const bitacoraMsg = await channel.messages.fetch(pending.messageId);
      const attachments = [...message.attachments.values()];
      const photoLinks = attachments.map((a, i) => `[Foto ${i + 1}](${a.url})`).join(' | ');
      const updatedEmbed = EmbedBuilder.from(bitacoraMsg.embeds[0]).addFields({ name: '📸 Fotos de Detenidos', value: photoLinks });
      await bitacoraMsg.edit({ embeds: [updatedEmbed] });

      const archivoChannel = await client.channels.fetch(process.env.ARCHIVO_CHANNEL_ID).catch(() => null);
      if (archivoChannel) {
        await archivoChannel.send({
          content: `📸 **Fotos de detenidos** — bitácora de <@${message.author.id}>`,
          files: attachments.map(a => a.url),
        });
      }
      await message.delete().catch(() => {});
    } catch (e) {
      console.error('Error adjuntando fotos:', e);
    }
  }
});

// ─── CERRAR TURNO AL SALIR DEL SERVIDOR ──────────────────────────────────────
client.on('guildMemberRemove', async (member) => {
  const data = loadData();
  const session = data.sessions[member.id];
  if (!session) return;
  const duration = Date.now() - session.start;
  if (!data.history[member.id]) data.history[member.id] = { username: member.user.tag, totalMs: 0, sessions: [] };
  data.history[member.id].totalMs += duration;
  data.history[member.id].sessions.push({ start: session.start, end: Date.now(), duration });
  delete data.sessions[member.id];
  saveData(data);
  console.log(`Turno cerrado automáticamente para ${member.user.tag} (salió del servidor).`);
  const radioChannel = await client.channels.fetch(process.env.RADIO_CHANNEL_ID).catch(() => null);
  if (radioChannel) await radioChannel.send(`🔴 **${member.nickname || member.user.username}** ha salido del servidor. Turno cerrado automáticamente. Duración: **${formatDuration(duration)}**`);
});

client.login(process.env.TOKEN);


