import {
  Client, GatewayIntentBits, Partials, Events, REST, Routes,
  SlashCommandBuilder, Interaction, EmbedBuilder, Message, MessageFlags, ActionRowBuilder,
  ButtonBuilder, ButtonStyle, ComponentType, CacheType, StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder, User
} from 'discord.js';
import { config } from 'dotenv';
import {
  initDB, getPoints, addPoints, getLastDaily,
  setLastDaily, getTopUsers, ensureUserExists,
  getUserProfile, updateUserProfile, getShopItems, buyShopItem,
  getUserInventory, addToInventory
} from './db';

config();

const MIN_BET = 200;
const MIN_TRANSFER = 200;
const MIN_PVP_BET = 500;

const POINT_INTERVAL = 60 * 1000; // 1 min
const ENTRY_TTL = 60 * 60 * 1000; // 1 hour

// PvP игры
const pvpGames = new Map<string, {
  creator: string;
  opponent?: string;
  bet: number;
  game: 'duel' | 'coinflip' | 'dice';
  createdAt: number;
}>();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildVoiceStates
  ],
  partials: [Partials.Message, Partials.Reaction, Partials.User]
});

const commands = [
  new SlashCommandBuilder().setName('balance').setDescription('Показать количество очков'),
  new SlashCommandBuilder().setName('profile').setDescription('Показать профиль игрока')
    .addUserOption(opt => opt.setName('user').setDescription('Пользователь (необязательно)')),
  new SlashCommandBuilder().setName('menu').setDescription('Главное меню казино'),
  new SlashCommandBuilder().setName('casino').setDescription('Классическое казино')
    .addIntegerOption(opt => opt.setName('amount').setDescription('Ставка').setRequired(true)),
  new SlashCommandBuilder().setName('jackpot').setDescription('Азартный режим')
    .addIntegerOption(opt => opt.setName('amount').setDescription('Ставка').setRequired(true)),
  new SlashCommandBuilder().setName('coinflip').setDescription('Орёл или решка')
    .addStringOption(opt => opt.setName('side').setDescription('Сторона').setRequired(true)
      .addChoices(
        { name: '🪙 Орёл', value: 'heads' },
        { name: '⚡ Решка', value: 'tails' }))
    .addIntegerOption(opt => opt.setName('amount').setDescription('Ставка').setRequired(true)),
  new SlashCommandBuilder().setName('pvp').setDescription('PvP меню - вызовы на дуэль'),
  new SlashCommandBuilder().setName('testcasino').setDescription('Проверить баланс казино'),
  new SlashCommandBuilder().setName('duel').setDescription('Вызвать игрока на дуэль')
    .addUserOption(opt => opt.setName('opponent').setDescription('Противник').setRequired(true))
    .addIntegerOption(opt => opt.setName('amount').setDescription('Ставка').setRequired(true))
    .addStringOption(opt => opt.setName('game').setDescription('Тип игры').setRequired(true)
      .addChoices(
        { name: '🎰 Слоты', value: 'slots' },
        { name: '🪙 Монетка', value: 'coinflip' },
        { name: '🎲 Кости', value: 'dice' })),
  new SlashCommandBuilder().setName('shop').setDescription('Магазин предметов'),
  new SlashCommandBuilder().setName('inventory').setDescription('Твой инвентарь'),
  new SlashCommandBuilder().setName('leaderboard').setDescription('Показать топ игроков'),
  new SlashCommandBuilder().setName('bet').setDescription('Сделать ставку против другого игрока').addUserOption(opt => opt.setName('opponent').setDescription('Против кого играем').setRequired(true)).addIntegerOption(opt => opt.setName('amount').setDescription('Ставка').setRequired(true)),
  new SlashCommandBuilder().setName('daily').setDescription('Получить ежедневный бонус'),
  new SlashCommandBuilder().setName('roulette').setDescription('Рулетка: выбери цвет и ставь')
    .addStringOption(opt => opt.setName('color').setDescription('Цвет').setRequired(true)
      .addChoices(
        { name: '🔴 Красный', value: 'red' },
        { name: '⚫ Чёрный', value: 'black' },
        { name: '🟢 Зелёный', value: 'green' }))
    .addIntegerOption(opt => opt.setName('amount').setDescription('Ставка').setRequired(true)),
  new SlashCommandBuilder().setName('dice').setDescription('Бросить кости')
    .addIntegerOption(opt => opt.setName('amount').setDescription('Ставка').setRequired(true)),
  new SlashCommandBuilder().setName('pay').setDescription('Передать очки другому участнику')
    .addUserOption(opt => opt.setName('user').setDescription('Кому').setRequired(true))
    .addIntegerOption(opt => opt.setName('amount').setDescription('Сколько').setRequired(true))
].map(c => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN!);
  const appId = client.application?.id;
  if (!appId) throw new Error('Не удалось получить application.id');
  await rest.put(
    Routes.applicationCommands(appId),
    { body: commands }
  );
}

const voiceJoinTimestamps = new Map();

// Анимированные эмодзи и гифки
const animations = {
  loading: ['⏳', '⌛', '⏳', '⌛'],
  slots: ['🎰', '🎲', '🃏', '🎯', '🎪'],
  win: ['🎉', '✨', '🎊', '💥', '🌟'],
  lose: ['💔', '😭', '🙈', '😵', '💸'],
  coinflip: ['🪙', '⚡', '🌟', '💫']
};

function getRandomAnimation(type: keyof typeof animations): string {
  const arr = animations[type];
  return arr[Math.floor(Math.random() * arr.length)];
}

async function createAnimatedMessage(interaction: any, title: string, description: string, color: any = 'Blue') {
  const loadingEmbed = new EmbedBuilder()
    .setTitle(`${getRandomAnimation('loading')} ${title}`)
    .setDescription('Обработка...')
    .setColor('Yellow');
  
  await interaction.editReply({ embeds: [loadingEmbed] });
  
  // Имитация загрузки
  await new Promise(resolve => setTimeout(resolve, 1500));
  
  const finalEmbed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(description)
    .setColor(color)
    .setTimestamp();
  
  return interaction.editReply({ embeds: [finalEmbed] });
}

client.once(Events.ClientReady, async () => {
  console.log(`✅ Бот успешно авторизован: ${client.user?.tag}`);
  await initDB();
  await registerCommands();

  // register all vc members
  for (const guild of client.guilds.cache.values()) {
    for (const channel of guild.channels.cache.values()) {
      if (channel.isVoiceBased()) {
        for (const member of channel.members.values()) {
          voiceJoinTimestamps.set(member.id, { joinedAt: Date.now() });
        }
      }
    }
  }

  //update saved vc members
  setInterval(async () => {
    const now = Date.now();

    for (const [userId, data] of voiceJoinTimestamps.entries()) {
      const { joinedAt } = data;
      await ensureUserExists(userId);

      if (now - joinedAt >= POINT_INTERVAL) {
        addPoints(userId, 10);
        voiceJoinTimestamps.set(userId, { joinedAt: now });
      }

      if (now - joinedAt >= ENTRY_TTL) {
        voiceJoinTimestamps.delete(userId);
      }
    }
  }, POINT_INTERVAL);

  // Очистка старых PvP игр
  setInterval(() => {
    const now = Date.now();
    for (const [gameId, game] of pvpGames.entries()) {
      if (now - game.createdAt > 300000) { // 5 минут
        pvpGames.delete(gameId);
      }
    }
  }, 60000);
});

client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  const userId = newState.id;

  if (!voiceJoinTimestamps.has(userId) && newState.channelId) {
    voiceJoinTimestamps.set(userId, { joinedAt: Date.now() });
  }
  else if (!newState.channelId) {
    voiceJoinTimestamps.delete(userId);
  }
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  await ensureUserExists(message.author.id);
  if (Math.random() < 0.5) {
    const pts = Math.floor(Math.random() * 5) + 1;
    await addPoints(message.author.id, pts);
  }
});

client.on(Events.MessageReactionAdd, async (reaction, user) => {
  if (user.bot || !reaction.message.author || reaction.message.author.id === user.id) return;
  await ensureUserExists(reaction.message.author.id);
  await addPoints(reaction.message.author.id, 1);
});

client.on(Events.InteractionCreate, async (interaction: Interaction) => {
  if (interaction.isChatInputCommand()) {
    await handleSlashCommand(interaction);
  } else if (interaction.isButton() || interaction.isStringSelectMenu()) {
    await handleComponentInteraction(interaction);
  }
});

async function handleSlashCommand(interaction: any) {
  try {
    await interaction.deferReply();

    const userId = interaction.user.id;
    await ensureUserExists(userId);

    switch (interaction.commandName) {
      case 'menu':
        await showMainMenu(interaction);
        break;

      case 'profile':
        await showProfile(interaction);
        break;

case 'balance': {
  const profile = await getUserProfile(userId);
  await interaction.editReply({
    embeds: [
      new EmbedBuilder()
        .setTitle('💰 Баланс')
        .setDescription(`**${interaction.user.displayName}**\n💎 Очки: **${profile.points.toLocaleString()}**\n🏆 Уровень: **${profile.level}**\n⭐ Опыт: **${profile.experience}**`)
        .setColor('Gold')
        .setThumbnail(interaction.user.displayAvatarURL())
        .setTimestamp()
    ]
  });
  break;
}

case 'testcasino': {
  await interaction.deferReply();
  const casinoBalance = await getPoints('casino');
  await interaction.editReply({
    content: `🎰 Баланс казино: **${casinoBalance.toLocaleString()}** очков.`
  });
  break;
}


      case 'bet': {
  const userId = interaction.user.id;
  const opponent = interaction.options.getUser('opponent', true);
  const bet = interaction.options.getInteger('amount', true);

  if (opponent.bot || opponent.id === userId) {
    await interaction.reply({ content: 'Нельзя играть с самим собой или ботом.', ephemeral: true });
    return;
  }

  const userPoints = await getPoints(userId);
  const oppPoints = await getPoints(opponent.id);

  if (userPoints < bet || oppPoints < bet) {
    await interaction.reply({ content: 'Один из игроков не имеет достаточно очков.', ephemeral: true });
    return;
  }

  const win = Math.random() < 0.5;
  const winner = win ? userId : opponent.id;
  const loser = win ? opponent.id : userId;

  await addPoints(winner, bet);
  await addPoints(loser, -bet);

  await interaction.reply({
    embeds: [
      new EmbedBuilder()
        .setTitle('⚔️ Дуэль игроков')
        .setDescription(`${interaction.user.username} VS ${opponent.username}\n\n🎲 Победитель: <@${winner}>\n💰 Ставка: ${bet}`)
        .setColor('Purple')
    ]
  });
  break;
}

      case 'daily': {
        const last = await getLastDaily(userId);
        const now = Date.now();

        if (last && now - last < 86400000) {
          const left = 86400000 - (now - last);
          const hours = Math.floor(left / 3600000);
          const minutes = Math.floor((left % 3600000) / 60000);

          await interaction.deleteReply();
          await interaction.followUp({ 
            content: `⏰ Уже получал! Жди **${hours}ч ${minutes}м**`, 
            flags: MessageFlags.Ephemeral 
          });
          return;
        }

        const profile = await getUserProfile(userId);
        const bonus = 100 + Math.floor(Math.random() * 50) + (profile.level * 10);
        const expGain = 25;
        
        await addPoints(userId, bonus);
        await updateUserProfile(userId, { experience: profile.experience + expGain });
        await setLastDaily(userId, now);

        await createAnimatedMessage(
          interaction,
          '🎁 Ежедневный бонус',
          `${getRandomAnimation('win')} **+${bonus}** очков!\n⭐ **+${expGain}** опыта!`,
          'Green'
        );
        break;
      }

      case 'coinflip': {
        const bet = interaction.options.getInteger('amount', true);
        const side = interaction.options.getString('side', true);
        const balance = await getPoints(userId);

        if (bet < MIN_BET || balance < bet) {
          await interaction.deleteReply();
          await interaction.followUp({ 
            content: `⚠️ Минимальная ставка **${MIN_BET}** очков!`, 
            flags: MessageFlags.Ephemeral 
          });
          return;
        }

        // Анимация подбрасывания монеты
        const loadingEmbed = new EmbedBuilder()
          .setTitle('🪙 Подбрасываю монету...')
          .setDescription('🌀 Монета крутится в воздухе...')
          .setColor('Yellow');
        
        await interaction.editReply({ embeds: [loadingEmbed] });
        await new Promise(resolve => setTimeout(resolve, 2000));

        const result = Math.random() < 0.5 ? 'heads' : 'tails';
        const won = result === side;
        const winAmount = won ? bet * 2 : 0;
        
        await addPoints(userId, won ? bet : -bet);

        const resultEmoji = result === 'heads' ? '🪙' : '⚡';
        const sideEmoji = side === 'heads' ? '🪙' : '⚡';
        
        const embed = new EmbedBuilder()
          .setTitle('🪙 Подбрасывание монеты')
          .addFields(
            { name: '🎯 Выпало', value: `${resultEmoji} ${result === 'heads' ? 'Орёл' : 'Решка'}`, inline: true },
            { name: 'Твой выбор', value: `${sideEmoji} ${side === 'heads' ? 'Орёл' : 'Решка'}`, inline: true },
            { name: '💰 Результат', value: won ? `${getRandomAnimation('win')} **+${bet}** очков!` : `${getRandomAnimation('lose')} **-${bet}** очков`, inline: false }
          )
          .setColor(won ? 'Green' : 'Red')
          .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
        break;
      }

      case 'pvp':
        await showPvPMenu(interaction);
        break;

      case 'duel':
        await createDuel(interaction);
        break;

      case 'shop':
        await showShop(interaction);
        break;

      case 'inventory':
        await showInventory(interaction);
        break;

      case 'leaderboard': {
        const top = await getTopUsers(100);
        let page = 0;

        const getEmbed = (p: number) => {
          const embed = new EmbedBuilder()
            .setTitle('🏆 Топ игроков')
            .setDescription('Лучшие игроки казино')
            .setColor('Gold')
            .setTimestamp();
          
          top.slice(p * 10, p * 10 + 10).forEach((u, i) => {
            const rank = p * 10 + i + 1;
            const medal = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : '🏅';
            embed.addFields({
              name: `${medal} ${rank} место`,
              value: `<@${u.id}>\n💎 **${u.points.toLocaleString()}** очков`,
              inline: true
            });
          });
          
          return embed;
        };

        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId('prev').setLabel('◀ Назад').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId('next').setLabel('Вперёд ▶').setStyle(ButtonStyle.Secondary)
        );

        const msg = await interaction.editReply({ embeds: [getEmbed(page)], components: [row] });
        const collector = (msg as Message).createMessageComponentCollector({ 
          componentType: ComponentType.Button, 
          time: 60000 
        });

        collector.on('collect', async btn => {
          if (btn.user.id !== userId)
            return btn.reply({ 
              content: '❌ Эта кнопка только для автора команды!', 
              flags: MessageFlags.Ephemeral 
            });

          if (btn.customId === 'next' && (page + 1) * 10 < top.length) page++;
          else if (btn.customId === 'prev' && page > 0) page--;

          await btn.update({ embeds: [getEmbed(page)] });
        });
        break;
      }

      case 'pay': {
        const target = interaction.options.getUser('user', true);
        const amount = interaction.options.getInteger('amount', true);

        if (target.bot || target.id === userId) {
          await interaction.deleteReply();
          await interaction.followUp({ 
            content: `❌ Недопустимая операция!`, 
            flags: MessageFlags.Ephemeral 
          });
          return;
        }
        
        if (amount < MIN_TRANSFER) {
          await interaction.deleteReply();
          await interaction.followUp({ 
            content: `⚠️ Минимальная сумма перевода: **${MIN_TRANSFER}** очков`, 
            flags: MessageFlags.Ephemeral 
          });
          return;
        }
        
        const balance = await getPoints(userId);
        if (balance < amount) {
          await interaction.deleteReply();
          await interaction.followUp({ 
            content: `💸 Недостаточно очков! Не хватает **${amount - balance}** очков.`, 
            flags: MessageFlags.Ephemeral 
          });
          return;
        }

        await ensureUserExists(target.id);
        await addPoints(userId, -amount);
        await addPoints(target.id, amount);

        const embed = new EmbedBuilder()
          .setTitle('💸 Перевод завершён')
          .setDescription(`**${interaction.user.displayName}** → **${target.displayName}**\n💎 Сумма: **${amount.toLocaleString()}** очков`)
          .setColor('Green')
          .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
        break;
      }

      // игры
      case 'casino': {
        const bet = interaction.options.getInteger('amount', true);
        const balance = await getPoints(userId);

        if (bet < MIN_BET || balance < bet) {
          await interaction.deleteReply();
          await interaction.followUp({ 
            content: `⚠️ Минимальная ставка **${MIN_BET}** очков!`, 
            flags: MessageFlags.Ephemeral 
          });
          return;
        }

        // Анимация слотов
        const slots = ['🍒', '🍋', '🔔', '💎', '7️⃣'];
        const loadingEmbed = new EmbedBuilder()
          .setTitle('🎰 Казино')
          .setDescription('🎲 Барабаны крутятся...\n| ? | ? | ? |')
          .setColor('Blue');
        
        await interaction.editReply({ embeds: [loadingEmbed] });
        await new Promise(resolve => setTimeout(resolve, 2000));

        const result = Array.from({ length: 3 }, () => slots[Math.floor(Math.random() * slots.length)]);
        const jackpot = result.every(s => s === result[0]);
        const win = jackpot ? bet * 5 : 0;
        
        await addPoints(userId, win - bet);
        await addPoints('casino', bet - win); 


        const embed = new EmbedBuilder()
          .setTitle('🎰 Казино')
          .setDescription(`**| ${result.join(' | ')} |**\n\n${win > 0 ? 
            `${getRandomAnimation('win')} **ДЖЕКПОТ!** Выигрыш: **${win.toLocaleString()}** очков!` : 
            `${getRandomAnimation('lose')} Проигрыш: **${bet.toLocaleString()}** очков`}`)
          .setColor(win > 0 ? 'Green' : 'Red')
          .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
        break;
      }

      case 'jackpot': {
        const bet = interaction.options.getInteger('amount', true);
        const balance = await getPoints(userId);

        if (bet < MIN_BET || balance < bet) {
          await interaction.deleteReply();
          await interaction.followUp({ 
            content: `⚠️ Минимальная ставка **${MIN_BET}** очков!`, 
            flags: MessageFlags.Ephemeral 
          });
          return;
        }

        await createAnimatedMessage(interaction, '⚡ Джекпот', 'Определяю множитель...', 'Yellow');

        const chances = [
          { multiplier: 0, chance: 0.4 },
          { multiplier: 0.5, chance: 0.25 },
          { multiplier: 1, chance: 0.2 },
          { multiplier: 2, chance: 0.1 },
          { multiplier: 5, chance: 0.04 },
          { multiplier: 10, chance: 0.01 }
        ];

        let roll = Math.random(), acc = 0, multiplier = 0;
        for (const c of chances) {
          acc += c.chance;
          if (roll <= acc) { multiplier = c.multiplier; break; }
        }

        const win = Math.floor(bet * multiplier);
        await addPoints(userId, win - bet);

        const embed = new EmbedBuilder()
          .setTitle('⚡ Джекпот')
          .addFields(
            { name: '🎯 Ставка', value: `**${bet.toLocaleString()}** очков`, inline: true },
            { name: '🎲 Множитель', value: `**${multiplier}x**`, inline: true },
            { name: '💰 Результат', value: 
              win > bet ? `${getRandomAnimation('win')} **+${(win - bet).toLocaleString()}** очков!` :
              win === bet ? '🔄 Ничья!' :
              `${getRandomAnimation('lose')} **-${(bet - win).toLocaleString()}** очков`, 
              inline: false }
          )
          .setColor(win > bet ? 'Green' : win === bet ? 'Yellow' : 'Red')
          .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
        break;
      }

      case 'roulette': {
        const bet = interaction.options.getInteger('amount', true);
        const color = interaction.options.getString('color', true);
        const balance = await getPoints(userId);

        if (bet < MIN_BET || balance < bet) {
          await interaction.deleteReply();
          await interaction.followUp({ 
            content: `⚠️ Минимальная ставка **${MIN_BET}** очков!`, 
            flags: MessageFlags.Ephemeral 
          });
          return;
        }

        await createAnimatedMessage(interaction, '🎡 Рулетка', '🌀 Шарик крутится...', 'Purple');

        const wheel = Math.random();
        let resultColor = 'black';
        if (wheel < 0.027) resultColor = 'green';
        else if (wheel < 0.5135) resultColor = 'red';

        const colorEmojis = { red: '🔴', black: '⚫', green: '🟢' };
        const multiplier = color === resultColor ? (color === 'green' ? 14 : 2) : 0;
        const win = Math.floor(bet * multiplier);
        
        await addPoints(userId, win - bet);

        const embed = new EmbedBuilder()
          .setTitle('🎡 Рулетка')
          .addFields(
            { name: '🎯 Выпало', value: `${colorEmojis[resultColor as keyof typeof colorEmojis]} ${resultColor}`, inline: true },
            { name: 'Твой выбор', value: `${colorEmojis[color as keyof typeof colorEmojis]} ${color}`, inline: true },
            { name: '💰 Результат', value: 
              multiplier > 0 ? `${getRandomAnimation('win')} **+${(win - bet).toLocaleString()}** очков!` :
              `${getRandomAnimation('lose')} **-${bet.toLocaleString()}** очков`, 
              inline: false }
          )
          .setColor(multiplier > 0 ? 'Green' : 'Red')
          .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
        break;
      }

      case 'dice': {
        const bet = interaction.options.getInteger('amount', true);
        const balance = await getPoints(userId);

        if (bet < MIN_BET || balance < bet) {
          await interaction.deleteReply();
          await interaction.followUp({ 
            content: `⚠️ Минимальная ставка **${MIN_BET}** очков!`, 
            flags: MessageFlags.Ephemeral 
          });
          return;
        }

        await createAnimatedMessage(interaction, '🎲 Кости', '🎯 Бросаю кости...', 'Orange');

        const roll1 = Math.floor(Math.random() * 6) + 1;
        const roll2 = Math.floor(Math.random() * 6) + 1;
        const sum = roll1 + roll2;
        const multiplier = sum > 7 ? 2 : sum === 7 ? 1 : 0;
        const win = bet * multiplier;

        await addPoints(userId, win - bet);
        
        const embed = new EmbedBuilder()
          .setTitle('🎲 Кости')
          .addFields(
            { name: '🎯 Результат', value: `🎲 ${roll1} + 🎲 ${roll2} = **${sum}**`, inline: false },
            { name: '💰 Результат', value: 
              multiplier > 1 ? `${getRandomAnimation('win')} **+${(win - bet).toLocaleString()}** очков!` :
              multiplier === 1 ? '🔄 Ничья!' :
              `${getRandomAnimation('lose')} **-${bet.toLocaleString()}** очков`, 
              inline: false }
          )
          .setColor(multiplier > 1 ? 'Green' : multiplier === 1 ? 'Yellow' : 'Red')
          .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
        break;
      }
    }
  } catch (error) {
    console.error("Ошибка в обработчике команд:", error);
  }
}

async function showMainMenu(interaction: any) {
  const userId = interaction.user.id;
  const points = await getPoints(userId);
  const profile = await getUserProfile(userId);

  const embed = new EmbedBuilder()
    .setTitle('🎰 Главное меню казино')
    .setDescription(`Добро пожаловать, **${interaction.user.displayName}**!\n💎 Баланс: **${points.toLocaleString()}** очков\n🏆 Уровень: **${profile.level}**`)
    .setColor('Gold')
    .setThumbnail(interaction.user.displayAvatarURL())
    .addFields(
      { name: '🎮 Игры', value: 'Слоты, Рулетка, Кости, Джекпот', inline: true },
      { name: '⚔️ PvP', value: 'Дуэли с другими игроками', inline: true },
      { name: '🛒 Магазин', value: 'Покупай улучшения', inline: true }
    )
    .setTimestamp();

  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('games_menu').setLabel('🎮 Игры').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('pvp_menu').setLabel('⚔️ PvP').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('shop_menu').setLabel('🛒 Магазин').setStyle(ButtonStyle.Success)
  );

  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('profile_menu').setLabel('👤 Профиль').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('leaderboard_menu').setLabel('🏆 Рейтинг').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('daily_bonus').setLabel('🎁 Ежедневный бонус').setStyle(ButtonStyle.Secondary)
  );

  await interaction.editReply({ embeds: [embed], components: [row1, row2] });
}

async function showProfile(interaction: any) {
  const targetUser = interaction.options.getUser('user') || interaction.user;
  const profile = await getUserProfile(targetUser.id);
  const inventory = await getUserInventory(targetUser.id);

  const embed = new EmbedBuilder()
    .setTitle(`👤 Профиль ${targetUser.displayName}`)
    .setThumbnail(targetUser.displayAvatarURL())
    .setColor('Blue')
    .addFields(
      { name: '💎 Очки', value: `**${profile.points.toLocaleString()}**`, inline: true },
      { name: '🏆 Уровень', value: `**${profile.level}**`, inline: true },
      { name: '⭐ Опыт', value: `**${profile.experience}**/100`, inline: true },
      { name: '🎯 Побед', value: `**${profile.wins}**`, inline: true },
      { name: '🎮 Игр сыграно', value: `**${profile.gamesPlayed}**`, inline: true },
      { name: '📊 Винрейт', value: `**${profile.gamesPlayed > 0 ? Math.round((profile.wins / profile.gamesPlayed) * 100) : 0}%**`, inline: true }
    )
    .setTimestamp();

  if (inventory.length > 0) {
    const items = inventory.slice(0, 5).map(item => `${item.emoji} ${item.name} x${item.quantity}`).join('\n');
    embed.addFields({ name: '🎒 Инвентарь (топ 5)', value: items, inline: false });
  }

  await interaction.editReply({ embeds: [embed] });
}

async function showPvPMenu(interaction: any) {
  const activeGames = Array.from(pvpGames.entries()).filter(([_, game]) => 
    game.creator === interaction.user.id || game.opponent === interaction.user.id
  );

  const embed = new EmbedBuilder()
    .setTitle('⚔️ PvP Арена')
    .setDescription('Сражайся с другими игроками!')
    .setColor('Red')
    .addFields(
      { name: '🎰 Слоты', value: 'Кто больше наберёт', inline: true },
      { name: '🪙 Монетка', value: 'Угадай сторону', inline: true },
      { name: '🎲 Кости', value: 'Выше сумма побеждает', inline: true }
    );

  if (activeGames.length > 0) {
    const gamesList = activeGames.map(([id, game]) => {
      const status = game.opponent ? '🔄 В процессе' : '⏰ Ожидание';
      return `**${game.game.toUpperCase()}** - ${game.bet} очков ${status}`;
    }).join('\n');
    embed.addFields({ name: '🎯 Твои игры', value: gamesList, inline: false });
  }

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('create_duel').setLabel('⚔️ Создать дуэль').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('join_duel').setLabel('🎯 Присоединиться').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('active_duels').setLabel('📋 Активные дуэли').setStyle(ButtonStyle.Secondary)
  );

  await interaction.editReply({ embeds: [embed], components: [row] });
}

async function createDuel(interaction: any) {
  const opponent = interaction.options.getUser('opponent', true);
  const amount = interaction.options.getInteger('amount', true);
  const gameType = interaction.options.getString('game', true);

  if (opponent.bot || opponent.id === interaction.user.id) {
    await interaction.deleteReply();
    await interaction.followUp({ 
      content: '❌ Нельзя вызвать себя или бота!', 
      flags: MessageFlags.Ephemeral 
    });
    return;
  }

  if (amount < MIN_PVP_BET) {
    await interaction.deleteReply();
    await interaction.followUp({ 
      content: `⚠️ Минимальная ставка для PvP: **${MIN_PVP_BET}** очков!`, 
      flags: MessageFlags.Ephemeral 
    });
    return;
  }

  const balance = await getPoints(interaction.user.id);
  const opponentBalance = await getPoints(opponent.id);

  if (balance < amount || opponentBalance < amount) {
    await interaction.deleteReply();
    await interaction.followUp({ 
      content: '💸 У одного из игроков недостаточно очков!', 
      flags: MessageFlags.Ephemeral 
    });
    return;
  }

  const gameId = `${interaction.user.id}_${Date.now()}`;
  pvpGames.set(gameId, {
    creator: interaction.user.id,
    bet: amount,
    game: gameType as 'duel' | 'coinflip' | 'dice',
    createdAt: Date.now()
  });

  const gameNames = {
    'slots': '🎰 Слоты',
    'coinflip': '🪙 Монетка', 
    'dice': '🎲 Кости'
  };

  const embed = new EmbedBuilder()
    .setTitle('⚔️ Вызов на дуэль!')
    .setDescription(`**${interaction.user.displayName}** вызывает **${opponent.displayName}** на дуэль!`)
    .addFields(
      { name: '🎮 Игра', value: gameNames[gameType as keyof typeof gameNames], inline: true },
      { name: '💰 Ставка', value: `**${amount.toLocaleString()}** очков`, inline: true },
      { name: '⏰ Время', value: '5 минут на принятие', inline: true }
    )
    .setColor('Orange')
    .setTimestamp();

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`accept_duel_${gameId}`).setLabel('✅ Принять').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`decline_duel_${gameId}`).setLabel('❌ Отклонить').setStyle(ButtonStyle.Danger)
  );

  await interaction.editReply({ 
    content: `<@${opponent.id}>`, 
    embeds: [embed], 
    components: [row] 
  });
}

async function showShop(interaction: any) {
  const items = await getShopItems();
  const userPoints = await getPoints(interaction.user.id);

  if (items.length === 0) {
    await interaction.editReply({
      embeds: [new EmbedBuilder()
        .setTitle('🛒 Магазин')
        .setDescription('Магазин временно пуст!')
        .setColor('Yellow')]
    });
    return;
  }

  let page = 0;
  const itemsPerPage = 6;
  const maxPages = Math.ceil(items.length / itemsPerPage);

  const getEmbed = (p: number) => {
    const embed = new EmbedBuilder()
      .setTitle('🛒 Магазин предметов')
      .setDescription(`💎 Ваш баланс: **${userPoints.toLocaleString()}** очков\n📄 Страница ${p + 1}/${maxPages}`)
      .setColor('Green')
      .setTimestamp();

    const pageItems = items.slice(p * itemsPerPage, (p + 1) * itemsPerPage);
    pageItems.forEach(item => {
      const affordable = userPoints >= item.price ? '✅' : '❌';
      embed.addFields({
        name: `${item.emoji} ${item.name}`,
        value: `${item.description}\n💰 **${item.price.toLocaleString()}** очков ${affordable}`,
        inline: true
      });
    });

    return embed;
  };

  const getButtons = (p: number) => {
    const row1 = new ActionRowBuilder<ButtonBuilder>();
    const pageItems = items.slice(p * itemsPerPage, (p + 1) * itemsPerPage);
    
    pageItems.slice(0, 3).forEach((item, i) => {
      row1.addComponents(
        new ButtonBuilder()
          .setCustomId(`buy_${item.id}`)
          .setLabel(`${item.emoji} ${item.price.toLocaleString()}`)
          .setStyle(userPoints >= item.price ? ButtonStyle.Success : ButtonStyle.Secondary)
          .setDisabled(userPoints < item.price)
      );
    });

    const row2 = new ActionRowBuilder<ButtonBuilder>();
    pageItems.slice(3, 6).forEach((item, i) => {
      row2.addComponents(
        new ButtonBuilder()
          .setCustomId(`buy_${item.id}`)
          .setLabel(`${item.emoji} ${item.price.toLocaleString()}`)
          .setStyle(userPoints >= item.price ? ButtonStyle.Success : ButtonStyle.Secondary)
          .setDisabled(userPoints < item.price)
      );
    });

    const row3 = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('shop_prev').setLabel('◀ Назад').setStyle(ButtonStyle.Primary).setDisabled(p === 0),
      new ButtonBuilder().setCustomId('shop_next').setLabel('Вперёд ▶').setStyle(ButtonStyle.Primary).setDisabled(p === maxPages - 1),
      new ButtonBuilder().setCustomId('inventory_btn').setLabel('🎒 Инвентарь').setStyle(ButtonStyle.Secondary)
    );

    return [row1, row2, row3].filter(row => row.components.length > 0);
  };

  await interaction.editReply({ 
    embeds: [getEmbed(page)], 
    components: getButtons(page) 
  });
}

async function showInventory(interaction: any) {
  const inventory = await getUserInventory(interaction.user.id);
  
  if (inventory.length === 0) {
    await interaction.editReply({
      embeds: [new EmbedBuilder()
        .setTitle('🎒 Инвентарь')
        .setDescription('Твой инвентарь пуст!\nЗайди в 🛒 магазин, чтобы купить предметы.')
        .setColor('Yellow')
        .setThumbnail(interaction.user.displayAvatarURL())]
    });
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle('🎒 Твой инвентарь')
    .setDescription(`У тебя **${inventory.length}** уникальных предметов`)
    .setColor('Purple')
    .setThumbnail(interaction.user.displayAvatarURL())
    .setTimestamp();

  inventory.forEach(item => {
    embed.addFields({
      name: `${item.emoji} ${item.name}`,
      value: `${item.description}\n📦 Количество: **${item.quantity}**`,
      inline: true
    });
  });

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('shop_menu').setLabel('🛒 Магазин').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('use_items').setLabel('⚡ Использовать').setStyle(ButtonStyle.Success).setDisabled(true)
  );

  await interaction.editReply({ embeds: [embed], components: [row] });
}

async function handleComponentInteraction(interaction: any) {
  try {
    const userId = interaction.user.id;

    if (interaction.isButton()) {
      const customId = interaction.customId;

      // Основное меню
      if (customId === 'games_menu') {
        await interaction.deferUpdate();
        await showGamesMenu(interaction);
      }
      else if (customId === 'pvp_menu') {
        await interaction.deferUpdate();
        await showPvPMenu(interaction);
      }
      else if (customId === 'shop_menu') {
        await interaction.deferUpdate();
        await showShop(interaction);
      }
      else if (customId === 'profile_menu') {
        await interaction.deferUpdate();
        const profile = await getUserProfile(userId);
        const embed = new EmbedBuilder()
          .setTitle(`👤 Твой профиль`)
          .setThumbnail(interaction.user.displayAvatarURL())
          .setColor('Blue')
          .addFields(
            { name: '💎 Очки', value: `**${profile.points.toLocaleString()}**`, inline: true },
            { name: '🏆 Уровень', value: `**${profile.level}**`, inline: true },
            { name: '⭐ Опыт', value: `**${profile.experience}**/100`, inline: true },
            { name: '🎯 Побед', value: `**${profile.wins}**`, inline: true },
            { name: '🎮 Игр сыграно', value: `**${profile.gamesPlayed}**`, inline: true },
            { name: '📊 Винрейт', value: `**${profile.gamesPlayed > 0 ? Math.round((profile.wins / profile.gamesPlayed) * 100) : 0}%**`, inline: true }
          )
          .setTimestamp();

        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId('back_to_menu').setLabel('🔙 Назад').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId('inventory_btn').setLabel('🎒 Инвентарь').setStyle(ButtonStyle.Primary)
        );

        await interaction.editReply({ embeds: [embed], components: [row] });
      } else if (customId === 'daily_bonus') {
        await interaction.deferUpdate();
        await handleDailyBonus(interaction);
      } else if (customId === 'back_to_menu') {
        await interaction.deferUpdate();
        await showMainMenu(interaction);
      } else if (customId === 'inventory_btn') {
        await interaction.deferUpdate();
        await showInventory(interaction);
      }

      // Покупка предметов
      else if (customId.startsWith('buy_')) {
        await interaction.deferUpdate();
        const itemId = parseInt(customId.split('_')[1]);
        await handlePurchase(interaction, itemId);
      }
      else if (customId.startsWith('accept_duel_')) {
        await interaction.deferUpdate();
        const gameId = customId.replace('accept_duel_', '');
        await handleDuelAccept(interaction, gameId);
      }
      else if (customId.startsWith('decline_duel_')) {
        await interaction.deferUpdate();
        const gameId = customId.replace('decline_duel_', '');
        await handleDuelDecline(interaction, gameId);
      }

    }
    
  } catch (error) {
    console.error("Ошибка в обработчике взаимодействий:", error);
  }
}

async function showGamesMenu(interaction: any) {
  const profile = await getUserProfile(interaction.user.id);
  
  const embed = new EmbedBuilder()
    .setTitle('🎮 Игровое меню')
    .setDescription(`Выбери игру, **${interaction.user.displayName}**!\n💎 Баланс: **${profile.points.toLocaleString()}** очков`)
    .setColor('Blue')
    .addFields(
      { name: '🎰 Слоты (/casino)', value: 'Классические слоты\nМинимум: 200 очков', inline: true },
      { name: '⚡ Джекпот (/jackpot)', value: 'Азартный режим\nБольшие множители!', inline: true },
      { name: '🪙 Монетка (/coinflip)', value: 'Орёл или решка\nШанс 50/50', inline: true },
      { name: '🎡 Рулетка (/roulette)', value: 'Выбери цвет\nКрасный/Чёрный/Зелёный', inline: true },
      { name: '🎲 Кости (/dice)', value: 'Сумма > 7 = победа\nСумма = 7 = ничья', inline: true },
      { name: '⚔️ PvP (/pvp)', value: 'Играй против игроков\nМинимум: 500 очков', inline: true }
    )
    .setTimestamp();

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('back_to_menu').setLabel('🔙 Главное меню').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('pvp_menu').setLabel('⚔️ PvP Арена').setStyle(ButtonStyle.Danger)
  );

  await interaction.editReply({ embeds: [embed], components: [row] });
}

async function handleDailyBonus(interaction: any) {
  const userId = interaction.user.id;
  const last = await getLastDaily(userId);
  const now = Date.now();

  if (last && now - last < 86400000) {
    const left = 86400000 - (now - last);
    const hours = Math.floor(left / 3600000);
    const minutes = Math.floor((left % 3600000) / 60000);

    const embed = new EmbedBuilder()
      .setTitle('⏰ Ежедневный бонус')
      .setDescription(`Ты уже получал бонус сегодня!\nСледующий бонус через: **${hours}ч ${minutes}м**`)
      .setColor('Yellow')
      .setTimestamp();

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('back_to_menu').setLabel('🔙 Назад').setStyle(ButtonStyle.Secondary)
    );

    await interaction.editReply({ embeds: [embed], components: [row] });
    return;
  }

  const profile = await getUserProfile(userId);
  const bonus = 100 + Math.floor(Math.random() * 50) + (profile.level * 10);
  const expGain = 25;
  
  await addPoints(userId, bonus);
  await updateUserProfile(userId, { experience: profile.experience + expGain });
  await setLastDaily(userId, now);

  const embed = new EmbedBuilder()
    .setTitle('🎁 Ежедневный бонус получен!')
    .setDescription(`${getRandomAnimation('win')} **+${bonus}** очков!\n⭐ **+${expGain}** опыта!\n\n💡 Приходи каждый день за бонусом!`)
    .setColor('Green')
    .setThumbnail(interaction.user.displayAvatarURL())
    .setTimestamp();

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('back_to_menu').setLabel('🔙 Главное меню').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('shop_menu').setLabel('🛒 Потратить в магазине').setStyle(ButtonStyle.Success)
  );

  await interaction.editReply({ embeds: [embed], components: [row] });
}

async function handlePurchase(interaction: any, itemId: number) {
  const userId = interaction.user.id;
  const userPoints = await getPoints(userId);
  const items = await getShopItems();
  const item = items.find(i => i.id === itemId);

  if (!item) {
    await interaction.followUp({ 
      content: '❌ Предмет не найден!', 
      flags: MessageFlags.Ephemeral 
    });
    return;
  }

  if (userPoints < item.price) {
    await interaction.followUp({ 
      content: `💸 Недостаточно очков! Нужно ещё **${item.price - userPoints}** очков.`, 
      flags: MessageFlags.Ephemeral 
    });
    return;
  }

  try {
    await buyShopItem(userId, itemId);
    await addPoints(userId, -item.price);

    const embed = new EmbedBuilder()
      .setTitle('✅ Покупка совершена!')
      .setDescription(`Ты купил **${item.emoji} ${item.name}**!\n💰 Потрачено: **${item.price.toLocaleString()}** очков`)
      .setColor('Green')
      .setTimestamp();

    await interaction.followUp({ embeds: [embed], flags: MessageFlags.Ephemeral });
    
    // Обновляем магазин
    await showShop(interaction);
  } catch (error) {
    await interaction.followUp({ 
      content: '❌ Ошибка при покупке!', 
      flags: MessageFlags.Ephemeral 
    });
  }
}

async function handleDuelAccept(interaction: any, gameId: string) {
  const game = pvpGames.get(gameId);
  if (!game) {
    await interaction.followUp({ 
      content: '❌ Дуэль не найдена или истекла!', 
      flags: MessageFlags.Ephemeral 
    });
    return;
  }

  if (interaction.user.id !== game.creator && interaction.user.id === game.opponent) {
    await interaction.followUp({ 
      content: '❌ Ты не можешь принять эту дуэль!', 
      flags: MessageFlags.Ephemeral 
    });
    return;
  }

  // Устанавливаем противника
  game.opponent = interaction.user.id;
  
  // Запускаем игру
  await startPvPGame(interaction, gameId, game);
}

async function handleDuelDecline(interaction: any, gameId: string) {
  const game = pvpGames.get(gameId);
  if (!game) {
    await interaction.followUp({ 
      content: '❌ Дуэль не найдена!', 
      flags: MessageFlags.Ephemeral 
    });
    return;
  }

  pvpGames.delete(gameId);
  
  const embed = new EmbedBuilder()
    .setTitle('❌ Дуэль отклонена')
    .setDescription(`**${interaction.user.displayName}** отклонил дуэль!`)
    .setColor('Red')
    .setTimestamp();

  await interaction.editReply({ embeds: [embed], components: [] });
}

async function startPvPGame(interaction: any, gameId: string, game: any) {
  const creator = await interaction.guild.members.fetch(game.creator);
  const opponent = await interaction.guild.members.fetch(game.opponent);

  // Списываем ставки
  await addPoints(game.creator, -game.bet);
  await addPoints(game.opponent, -game.bet);

  let result = '';
  let winner = '';

  switch (game.game) {
    case 'slots': {
      const slots = ['🍒', '🍋', '🔔', '💎', '7️⃣'];
      const creatorResult = Array.from({ length: 3 }, () => slots[Math.floor(Math.random() * slots.length)]);
      const opponentResult = Array.from({ length: 3 }, () => slots[Math.floor(Math.random() * slots.length)]);
      
      const creatorScore = creatorResult.every(s => s === creatorResult[0]) ? 3 : creatorResult.filter((s, i, arr) => arr.indexOf(s) !== i).length;
      const opponentScore = opponentResult.every(s => s === opponentResult[0]) ? 3 : opponentResult.filter((s, i, arr) => arr.indexOf(s) !== i).length;
      
      result = `**${creator.displayName}:** | ${creatorResult.join(' | ')} |\n**${opponent.displayName}:** | ${opponentResult.join(' | ')} |`;
      
      if (creatorScore > opponentScore) winner = game.creator;
      else if (opponentScore > creatorScore) winner = game.opponent;
      break;
    }
    
    case 'coinflip': {
      const creatorChoice = Math.random() < 0.5 ? 'heads' : 'tails';
      const opponentChoice = creatorChoice === 'heads' ? 'tails' : 'heads';
      const coinResult = Math.random() < 0.5 ? 'heads' : 'tails';
      
      result = `🪙 Выпало: **${coinResult === 'heads' ? 'Орёл' : 'Решка'}**\n${creator.displayName}: ${creatorChoice === 'heads' ? '🪙' : '⚡'}\n${opponent.displayName}: ${opponentChoice === 'heads' ? '🪙' : '⚡'}`;
      
      if (coinResult === creatorChoice) winner = game.creator;
      else winner = game.opponent;
      break;
    }
    
    case 'dice': {
      const creatorRoll = Math.floor(Math.random() * 6) + 1 + Math.floor(Math.random() * 6) + 1;
      const opponentRoll = Math.floor(Math.random() * 6) + 1 + Math.floor(Math.random() * 6) + 1;
      
      result = `**${creator.displayName}:** 🎲 ${creatorRoll}\n**${opponent.displayName}:** 🎲 ${opponentRoll}`;
      
      if (creatorRoll > opponentRoll) winner = game.creator;
      else if (opponentRoll > creatorRoll) winner = game.opponent;
      break;
    }
  }

  // Определяем победителя и выплачиваем приз
  if (winner) {
    await addPoints(winner, game.bet * 2);
    const winnerMember = winner === game.creator ? creator : opponent;
    
    // Обновляем статистику
    const winnerProfile = await getUserProfile(winner);
    const loserProfile = await getUserProfile(winner === game.creator ? game.opponent : game.creator);
    
    await updateUserProfile(winner, { 
      wins: winnerProfile.wins + 1, 
      gamesPlayed: winnerProfile.gamesPlayed + 1,
      experience: winnerProfile.experience + 50
    });
    await updateUserProfile(winner === game.creator ? game.opponent : game.creator, { 
      gamesPlayed: loserProfile.gamesPlayed + 1,
      experience: loserProfile.experience + 25
    });

    const embed = new EmbedBuilder()
      .setTitle('⚔️ Результат дуэли')
      .setDescription(`${result}\n\n🏆 **Победитель:** ${winnerMember.displayName}\n💰 **Выигрыш:** ${(game.bet * 2).toLocaleString()} очков`)
      .setColor('Green')
      .setTimestamp();

    await interaction.editReply({ embeds: [embed], components: [] });
  } else {
    // Ничья - возвращаем ставки
    await addPoints(game.creator, game.bet);
    await addPoints(game.opponent, game.bet);

    const embed = new EmbedBuilder()
      .setTitle('⚔️ Результат дуэли')
      .setDescription(`${result}\n\n🤝 **Ничья!** Ставки возвращены.`)
      .setColor('Yellow')
      .setTimestamp();

    await interaction.editReply({ embeds: [embed], components: [] });
  }

  pvpGames.delete(gameId);
}

client.login(process.env.BOT_TOKEN);
