import {
  Client, GatewayIntentBits, Partials, Events, REST, Routes,
  SlashCommandBuilder, Interaction, EmbedBuilder
} from 'discord.js';
import { config } from 'dotenv';
import {
  initDB, getPoints, addPoints, getLastDaily,
  setLastDaily, getTopUsers, ensureUserExists
} from './db';

config();

const MIN_BET = 500;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions
  ],
  partials: [Partials.Message, Partials.Reaction, Partials.User]
});

const commands = [
  new SlashCommandBuilder().setName('balance').setDescription('Показать количество очков'),
  new SlashCommandBuilder().setName('casino').setDescription('Играть в казино')
    .addIntegerOption(opt => opt.setName('amount').setDescription('Ставка').setRequired(true)),
  new SlashCommandBuilder().setName('leaderboard').setDescription('Показать топ игроков'),
  new SlashCommandBuilder().setName('daily').setDescription('Получить ежедневный бонус'),
  new SlashCommandBuilder().setName('roulette').setDescription('Рулетка: выбери цвет и ставь')
    .addStringOption(opt => opt.setName('color').setDescription('Цвет').setRequired(true)
      .addChoices(
        { name: 'Красный', value: 'red' },
        { name: 'Чёрный', value: 'black' },
        { name: 'Зелёный', value: 'green' }))
    .addIntegerOption(opt => opt.setName('amount').setDescription('Ставка').setRequired(true)),
  new SlashCommandBuilder().setName('dice').setDescription('Бросить кости')
    .addIntegerOption(opt => opt.setName('amount').setDescription('Ставка').setRequired(true))
].map(c => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(process.env.BOT_TOKEN!);
  await rest.put(Routes.applicationCommands(process.env.CLIENT_ID!), { body: commands });
}

client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user?.tag}`);
  await initDB();
  await registerCommands();
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
  if (!interaction.isChatInputCommand()) return;

  const userId = interaction.user.id;
  await ensureUserExists(userId);

  if (interaction.commandName === 'balance') {
    const points = await getPoints(userId);
    await interaction.reply({ embeds: [new EmbedBuilder()
      .setTitle('Баланс')
      .setDescription(`У тебя ${points} очков`)
      .setColor('Blue')] });
  }

  else if (interaction.commandName === 'daily') {
    const last = await getLastDaily(userId);
    const now = Date.now();

    if (last && now - last < 86400000) {
      const left = 86400000 - (now - last);
      const hours = Math.floor(left / 3600000);
      const minutes = Math.floor((left % 3600000) / 60000);
      await interaction.reply({ content: `Уже получал. Жди ${hours}ч ${minutes}м`, ephemeral: true });
      return;
    }

    const bonus = 100 + Math.floor(Math.random() * 50);
    await addPoints(userId, bonus);
    await setLastDaily(userId, now);

    await interaction.reply({ embeds: [new EmbedBuilder()
      .setTitle('Ежедневный бонус')
      .setDescription(`+${bonus} очков!`)
      .setColor('Green')] });
  }

  else if (interaction.commandName === 'leaderboard') {
    const top = await getTopUsers(10);
    const embed = new EmbedBuilder().setTitle('Топ игроков').setColor('Gold');
    top.forEach((u, i) => embed.addFields({ name: `${i + 1}.`, value: `<@${u.id}> — ${u.points} очков` }));
    await interaction.reply({ embeds: [embed] });
  }

  else if (['casino', 'roulette', 'dice'].includes(interaction.commandName)) {
    const bet = interaction.options.getInteger('amount', true);
    const balance = await getPoints(userId);

    if (bet < MIN_BET) {
      await interaction.reply({ content: `Минимальная ставка: ${MIN_BET} очков`, ephemeral: true });
      return;
    }
    if (balance < bet) {
      await interaction.reply({ content: 'Недостаточно очков.', ephemeral: true });
      return;
    }

    if (interaction.commandName === 'casino') {
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

      const result = win > bet ? `🎉 Выигрыш: ${win - bet} очков!` :
        win === bet ? 'Ничья, ставка возвращена.' :
        `Проигрыш: ${bet - win} очков.`;

      await interaction.reply({ embeds: [new EmbedBuilder()
        .setTitle('Казино')
        .setDescription(`Ставка: ${bet}\nМножитель: ${multiplier}x\n${result}`)
        .setColor(win > bet ? 'Green' : win === bet ? 'Yellow' : 'Red')] });
    }

else if (interaction.commandName === 'roulette') {
  const bet = interaction.options.getInteger('amount', true);
  const color = interaction.options.getString('color', true);
  const balance = await getPoints(userId);

  if (bet < 500) {
    await interaction.reply({ content: 'Минимальная ставка — 500 очков.', ephemeral: true });
    return;
  }

  if (balance < bet) {
    await interaction.reply({ content: 'Недостаточно очков для ставки.', ephemeral: true });
    return;
  }

  const wheel = Math.random();
  let resultColor = 'black';

  if (wheel < 0.027) resultColor = 'green';
  else if (wheel < 0.027 + 0.4865) resultColor = 'red';
  else resultColor = 'black';

  let multiplier = 0;
  if (color === resultColor) {
    multiplier = (color === 'green') ? 14 : 2;
  }

  const winnings = Math.floor(bet * multiplier);
  const netChange = winnings - bet;

  await addPoints(userId, netChange); // 💰 корректное изменение баланса

  const embed = new EmbedBuilder()
    .setTitle('Рулетка')
    .setDescription(
      `Ты поставил: ${bet} очков на ${color}\nВыпало: ${resultColor}\n` +
      (multiplier > 0
        ? `🎉 Выигрыш: ${winnings} очков!`
        : `Проигрыш: ${bet} очков.`)
    )
    .setColor(multiplier > 0 ? 'Green' : 'Red');

  await interaction.reply({ embeds: [embed] });
}

    else if (interaction.commandName === 'dice') {
      const roll1 = Math.floor(Math.random() * 6) + 1;
      const roll2 = Math.floor(Math.random() * 6) + 1;
      const sum = roll1 + roll2;
      let multiplier = 0;
      if (sum > 7) multiplier = 2;
      else if (sum === 7) multiplier = 1;

      const win = Math.floor(bet * multiplier);
      await addPoints(userId, win - bet);
      await interaction.reply({ embeds: [new EmbedBuilder()
        .setTitle('Кости')
        .setDescription(`Бросок: ${roll1} и ${roll2} (сумма ${sum})\n${multiplier ? `🎉 Выигрыш: ${win - bet} очков!` : `Проигрыш: ${bet} очков.`}`)
        .setColor(multiplier ? 'Green' : 'Red')] });
    }
  }
});

client.login(process.env.BOT_TOKEN);
