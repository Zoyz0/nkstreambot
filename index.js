/*
 * Ultimate Discord Selfbot: 24/7 Live DASH Streamer (Token Hardcoded)
 * Features:
 *  - Hardcoded token (no .env required)
 *  - Dynamic VC selection and switching via DM (owner only)
 *  - Resilient voice connection with auto-reconnect
 *  - Auto-restart on audio or connection failures
 *  - DM commands: setvc/switchvc, setstream, setcookie, start, stop, restart, reconnect, volume, status, info, help
 *  - Graceful shutdown
 *
 * Installation:
 *   npm install discord.js @discordjs/voice ffmpeg-static tough-cookie node-fetch fetch-cookie
 *
 * Usage:
 *   node index.js
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
import { CookieJar } from 'tough-cookie';
import fetch from 'node-fetch';
import fetchCookie from 'fetch-cookie';

// === Hardcoded Configuration ===
const USER_TOKEN = process.env.USER_TOKEN || 'YOUR_DISCORD_USER_TOKEN_HERE'; // Use env if available, else fallback
const OWNER_ID = process.env.OWNER_ID || 'YOUR_OWNER_ID_HERE';
let currentVoiceChannelId = null;
let STREAM_URL = 'https://tv.nknews.org/tvdash/stream.mpd';
let COOKIE = '';
const RECONNECT_INTERVAL = 30000;
const FF_RESTART_DELAY = 5000;

const jar = new CookieJar();
const fetchWithCookie = fetchCookie(fetch, jar);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.DirectMessages
  ],
  partials: ['CHANNEL']
});

let audioPlayer;
let connection;
let ffmpegProcess;
let isStreaming = false;

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
      console.warn('Voice disconnected. Attempting reconnect...');
      try {
        await Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, RECONNECT_INTERVAL),
          entersState(connection, VoiceConnectionStatus.Connecting, RECONNECT_INTERVAL)
        ]);
        console.log('Reconnected to voice channel');
      } catch {
        connection.destroy();
        console.error('Reconnect failed; retrying');
        setTimeout(connectVoice, RECONNECT_INTERVAL);
      }
    });

    await entersState(connection, VoiceConnectionStatus.Ready, 20000);
    console.log('Connected to VC:', currentVoiceChannelId);
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
      console.log('Audio idle, restarting stream');
      startStream();
    });
    audioPlayer.on('error', err => {
      console.error('Audio player error:', err);
      restartStream();
    });
  }
  connection.subscribe(audioPlayer);
}

function startStream() {
  if (!connection) return;
  if (ffmpegProcess) ffmpegProcess.kill('SIGKILL');

  console.log('Starting stream:', STREAM_URL);
  const args = [
    '-re',
    ...(COOKIE ? ['-headers', `Cookie: ${COOKIE}`] : []),
    '-i', STREAM_URL,
    '-analyzeduration', '0',
    '-loglevel', '0',
    '-acodec', 'libopus',
    '-f', 'opus',
    'pipe:1'
  ];

  ffmpegProcess = spawn(ffmpeg, args);
  ffmpegProcess.on('exit', (code, signal) => {
    console.warn(`FFmpeg exited (${code||signal}), restarting in ${FF_RESTART_DELAY}ms`);
    setTimeout(startStream, FF_RESTART_DELAY);
  });

  const resource = createAudioResource(ffmpegProcess.stdout, {
    inputType: StreamType.Opus,
    inlineVolume: true
  });
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
  connectVoice().then(() => startStream());
}

client.on(Events.MessageCreate, async msg => {
  if (msg.channel.type !== 'DM' || msg.author.id !== OWNER_ID) return;
  const [cmd, ...args] = msg.content.trim().split(/\s+/);
  switch (cmd.toLowerCase()) {
    case 'setvc':
    case 'switchvc':
      currentVoiceChannelId = args[0];
      await msg.reply(`VC set to ${currentVoiceChannelId}`);
      if (isStreaming) {
        await connectVoice();
        startStream();
      }
      break;
    case 'setstream':
      STREAM_URL = args[0];
      msg.reply(`Stream URL set to ${STREAM_URL}`);
      if (isStreaming) restartStream();
      break;
    case 'setcookie':
      COOKIE = args.join(' ');
      msg.reply('Cookie updated');
      if (isStreaming) restartStream();
      break;
    case 'start':
      if (!currentVoiceChannelId) return msg.reply('Use `setvc <id>` first');
      await msg.reply('Starting...');
      await connectVoice();
      startStream();
      msg.reply('Streaming started');
      break;
    case 'stop':
      stopStream();
      msg.reply('Streaming stopped');
      break;
    case 'restart':
      msg.reply('Restarting...');
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
        msg.reply('Usage: volume <0.0-2.0>');
      }
      break;
    case 'status':
      msg.reply(`VC: ${currentVoiceChannelId || 'none'}\nStreaming: ${isStreaming}\nPlayer: ${audioPlayer?.state.status || 'N/A'}\nConnection: ${connection?.state.status || 'N/A'}`);
      break;
    case 'info':
      msg.reply(`Owner: ${OWNER_ID}\nStream: ${STREAM_URL}\nCookie: ${COOKIE? 'set':'none'}\nReconnect interval: ${RECONNECT_INTERVAL}ms`);
      break;
    case 'help':
      msg.reply(
        'Commands: setvc/switchvc <id>, setstream <url>, setcookie <cookie>, start, stop, restart, reconnect, volume <0-2>, status, info, help'
      );
      break;
    default:
      msg.reply('Unknown. Type `help`');
  }
});

process.on('SIGINT', async () => {
  stopStream();
  await client.destroy();
  process.exit(0);
});

client.login(USER_TOKEN)
  .then(() => console.log('Selfbot online'))
  .catch(err => {
    console.error('Login failed:', err);
    process.exit(1);
  });
