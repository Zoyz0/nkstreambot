/*
 * Ultimate Discord Selfbot: 24/7 Live DASH Streamer (Enhanced)
 * Features:
 *  - Selfbot login with user token and cookie support
 *  - Dynamic VC selection and switching via DM (only for owner)
 *  - Resilient voice connection with auto-reconnect
 *  - Auto-restart on audio or connection failures
 *  - DM commands: setvc/switchvc, start, stop, restart, reconnect, volume, status, info, help
 *  - Graceful shutdown and cleanup
 *  - Env-configurable defaults and intervals
 *
 * Installation:
 *   npm install discord.js @discordjs/voice ffmpeg-static dotenv tough-cookie fetch-cookie
 *
 * Usage:
 *   - Create a .env file with:
 *       DISCORD_USER_TOKEN=your_token
 *       OWNER_ID=your_user_id
 *       DEFAULT_VOICE_CHANNEL_ID=<optional default vc id>
 *       STREAM_URL=https://example.com/stream.mpd
 *       RECONNECT_INTERVAL=30000            # ms
 *       FF_RESTART_DELAY=5000               # ms
 *   - Run: node index.js
 */

import { Client, GatewayIntentBits, Events } from 'discord.js';
import {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  StreamType,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState
} from '@discordjs/voice';
import ffmpeg from 'ffmpeg-static';
import { spawn } from 'child_process';
import dotenv from 'dotenv';
import { CookieJar } from 'tough-cookie';
import fetch from 'node-fetch';
import fetchCookie from 'fetch-cookie';

dotenv.config();

// Configurable
const USER_TOKEN = process.env.DISCORD_USER_TOKEN;
const OWNER_ID = process.env.OWNER_ID;
let currentVoiceChannelId = process.env.DEFAULT_VOICE_CHANNEL_ID || null;
const STREAM_URL = process.env.STREAM_URL;
const RECONNECT_INTERVAL = Number(process.env.RECONNECT_INTERVAL) || 30_000;
const FF_RESTART_DELAY = Number(process.env.FF_RESTART_DELAY) || 5_000;

// Setup cookie-based fetch
const jar = new CookieJar();
const fetchWithCookie = fetchCookie(fetch, jar);

// Discord client
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.DirectMessages], partials: ['CHANNEL'] });
let audioPlayer;
let connection;
let ffmpegProcess;
let isStreaming = false;

// Connect or switch voice channel
async function connectVoice() {
  if (!currentVoiceChannelId) return;
  try {
    const channel = await client.channels.fetch(currentVoiceChannelId);
    if (connection) connection.destroy();
    connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf: false
    });

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
      console.warn('Voice disconnected. Reconnecting...');
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, RECONNECT_INTERVAL),
          entersState(connection, VoiceConnectionStatus.Connecting, RECONNECT_INTERVAL)
        ]);
        console.log('Reconnected to VC');
      } catch {
        connection.destroy();
        console.error('Reconnect failed; retrying');
        setTimeout(connectVoice, RECONNECT_INTERVAL);
      }
    });

    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    console.log('Connected to VC', currentVoiceChannelId);
    setupPlayer();
  } catch (err) {
    console.error('connectVoice error:', err);
    setTimeout(connectVoice, RECONNECT_INTERVAL);
  }
}

function setupPlayer() {
  if (!connection) return;
  if (!audioPlayer) {
    audioPlayer = createAudioPlayer();
    audioPlayer.on(AudioPlayerStatus.Idle, () => {
      console.log('Audio idle, restarting...');
      startStream();
    });
    audioPlayer.on('error', err => {
      console.error('Player error:', err);
      restartStream();
    });
  }
  connection.subscribe(audioPlayer);
}

function startStream() {
  if (!connection) return;
  if (ffmpegProcess) ffmpegProcess.kill('SIGKILL');

  console.log('Starting stream:', STREAM_URL);
  ffmpegProcess = spawn(ffmpeg, ['-re', '-i', STREAM_URL, '-analyzeduration', '0', '-loglevel', '0', '-acodec', 'libopus', '-f', 'opus', 'pipe:1']);

  ffmpegProcess.on('exit', (code, sig) => {
    console.warn(`FFmpeg exited (${code||sig}); restarting in ${FF_RESTART_DELAY}ms`);
    setTimeout(startStream, FF_RESTART_DELAY);
  });

  const resource = createAudioResource(ffmpegProcess.stdout, { inputType: StreamType.Opus, inlineVolume: true });
  resource.volume.setVolume(1.0);
  audioPlayer.play(resource);
  isStreaming = true;
}

function stopStream() {
  if (ffmpegProcess) ffmpegProcess.kill('SIGKILL');
  if (audioPlayer) audioPlayer.stop();
  if (connection) connection.destroy();
  ffmpegProcess = null;
  isStreaming = false;
  console.log('Streaming stopped');
}

function restartStream() {
  stopStream();
  connectVoice().then(() => {
    startStream();
  });
}

// DM command handling
client.on(Events.MessageCreate, async msg => {
  if (msg.channel.type !== 'DM' || msg.author.id !== OWNER_ID) return;
  const args = msg.content.trim().split(/\s+/);
  const cmd = args.shift().toLowerCase();

  switch (cmd) {
    case 'setvc':
    case 'switchvc':
      currentVoiceChannelId = args[0];
      await msg.reply(`Voice channel set to ${args[0]}`);
      if (isStreaming) {
        await msg.reply('Switching VC...');
        await connectVoice();
        startStream();
      }
      break;
    case 'start':
      if (!currentVoiceChannelId) return msg.reply('Set VC first with `setvc <channel_id>`');
      await msg.reply('Connecting and starting stream...');
      await connectVoice();
      startStream();
      msg.reply('Streaming started');
      break;
    case 'stop':
      stopStream();
      msg.reply('Streaming stopped');
      break;
    case 'restart':
      msg.reply('Restarting stream...');
      restartStream();
      break;
    case 'reconnect':
      msg.reply('Reconnecting voice...');
      await connectVoice();
      break;
    case 'volume':
      const vol = parseFloat(args[0]);
      if (audioPlayer && !isNaN(vol) && vol >= 0 && vol <= 2) {
        audioPlayer.state.resource.volume.setVolume(vol);
        msg.reply(`Volume set to ${vol}`);
      } else {
        msg.reply('Usage: volume <0.0 - 2.0>');
      }
      break;
    case 'status':
      msg.reply(`VC: ${currentVoiceChannelId || 'none'}\nStreaming: ${isStreaming}\nPlayer: ${audioPlayer?.state.status || 'N/A'}\nConnection: ${connection?.state.status || 'N/A'}`);
      break;
    case 'info':
      msg.reply(`Owner: ${OWNER_ID}\nStream URL: ${STREAM_URL}\nReconnect interval: ${RECONNECT_INTERVAL}ms\nFF restart delay: ${FF_RESTART_DELAY}ms`);
      break;
    case 'help':
      msg.reply(
        'Commands:\n' +
        'setvc/switchvc <id> - Choose voice channel and switch\n' +
        'start - Connect and start streaming\n' +
        'stop - Stop streaming and disconnect\n' +
        'restart - Restart stream pipeline\n' +
        'reconnect - Reconnect voice connection\n' +
        'volume <0-2> - Set volume\n' +
        'status - Show current status\n' +
        'info - Show config info\n' +
        'help - List commands'
      );
      break;
    default:
      msg.reply('Unknown command. Type `help` for list.');
  }
});

// Graceful shutdown
process.on('SIGINT', async () => {
  stopStream();
  await client.destroy();
  process.exit(0);
});

// Login selfbot
client.login(USER_TOKEN).then(() => console.log('Selfbot online')).catch(err => {
  console.error('Login error:', err);
  process.exit(1);
});
