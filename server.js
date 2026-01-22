const express = require('express');
const line = require('@line/bot-sdk');
const OpenAI = require('openai');
const { google } = require('googleapis');

const app = express();

// 環境変数の検証とトリム
const requiredEnvVars = [
  'LINE_CHANNEL_ACCESS_TOKEN',
  'LINE_CHANNEL_SECRET',
  'OPENAI_API_KEY',
  'GOOGLE_SERVICE_ACCOUNT_JSON'
];

for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    console.error(`❌ 環境変数 ${envVar} が設定されていません`);
    process.exit(1);
  }
}

// 環境変数をトリム（前後の空白・改行を削除）
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN.trim().replace(/\s+/g, '');
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET.trim().replace(/\s+/g, '');
const OPENAI_API_KEY = process.env.OPENAI_API_KEY.trim().replace(/\s+/g, '');

console.log('🔍 環境変数チェック:');
console.log(`LINE_CHANNEL_ACCESS_TOKEN: ${LINE_CHANNEL_ACCESS_TOKEN.substring(0, 10)}...${LINE_CHANNEL_ACCESS_TOKEN.substring(LINE_CHANNEL_ACCESS_TOKEN.length - 10)}`);
console.log(`LINE_CHANNEL_SECRET: ${LINE_CHANNEL_SECRET.substring(0, 10)}...`);
console.log(`OPENAI_API_KEY: ${OPENAI_API_KEY.substring(0, 10)}...${OPENAI_API_KEY.substring(OPENAI_API_KEY.length - 10)}`);

// LINE設定
const config = {
  channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: LINE_CHANNEL_SECRET
};

const client = new line.Client(config);

// OpenAI API設定
const openai = new OpenAI({
  apiKey: OPENAI_API_KEY
});

// Google認証設定
let auth;
try {
  const serviceAccountJson = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  auth = new google.auth.GoogleAuth({
    credentials: serviceAccountJson,
    scopes: [
      'https://www.googleapis.com/auth/calendar',
      'https://www.googleapis.com/auth/tasks'
    ]
  });
  console.log('✅ Google認証設定完了');
} catch (error) {
  console.error('❌ Google認証設定エラー:', error.message);
}

const calendar = google.calendar({ version: 'v3', auth });
const tasks = google.tasks({ version: 'v1', auth });

// Webhookエンドポイント
app.post('/webhook', line.middleware(config), async (req, res) => {
  try {
    const events = req.body.events;
    console.log('📩 受信イベント:', JSON.stringify(events, null, 2));

    await Promise.all(events.map(handleEvent));
    res.status(200).end();
  } catch (error) {
    console.error('❌ Webhookエラー:', error);
    res.status(500).end();
  }
});

// イベント処理
async function handleEvent(event) {
  if (event.type !== 'message' || event.message.type !== 'text') {
    console.log('⏭️  スキップ: メッセージイベントではありません');
    return null;
  }

  const userId = event.source.userId;
  const userMessage = event.message.text;

  console.log(`👤 ユーザーID: ${userId}`);
  console.log(`💬 メッセージ: ${userMessage}`);

  try {
    // OpenAI APIで解析
    const analysisResult = await analyzeWithOpenAI(userMessage);
    console.log('🤖 OpenAI解析結果:', JSON.stringify(analysisResult, null, 2));

    // カレンダーまたはタスクに追加
    if (analysisResult.type === 'calendar') {
      await addToCalendar(analysisResult);
      await sendPushMessage(userId, `📅 カレンダーに追加しました\n\n${analysisResult.title}`);
    } else if (analysisResult.type === 'task') {
      await addToTasks(analysisResult);
      await sendPushMessage(userId, `✅ タスクを追加しました\n\n${analysisResult.title}`);
    } else {
      await sendPushMessage(userId, '申し訳ございません。理解できませんでした。もう一度お試しください。');
    }
  } catch (error) {
    console.error('❌ イベント処理エラー:', error);
    await sendPushMessage(userId, `エラーが発生しました: ${error.message}`);
  }
}

// OpenAI APIで自然言語解析
async function analyzeWithOpenAI(userMessage) {
  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `あなたは日本語の予定・タスク管理アシスタントです。
ユーザーのメッセージを解析し、JSON形式で返してください。

【解析ルール】
1. 時刻が明示されている場合 → type: "calendar"（カレンダー予定）
2. 時刻が明示されていない場合 → type: "task"（タスク）

【出力JSON形式】

カレンダーの場合:
{
  "type": "calendar",
  "title": "予定のタイトル",
  "start": "2026-01-24T14:00:00+09:00",
  "end": "2026-01-24T15:00:00+09:00",
  "description": "詳細説明"
}

タスクの場合:
{
  "type": "task",
  "title": "タスクのタイトル",
  "due": "2026-01-24T23:59:59+09:00",
  "notes": "メモ"
}

【重要】
- 日時は必ずISO 8601形式（+09:00タイムゾーン）で出力
- 今日の日付: ${new Date().toLocaleDateString('ja-JP')}
- 現在時刻: ${new Date().toLocaleTimeString('ja-JP')}
- 終了時刻が指定されていない場合は、開始時刻の1時間後を設定
- JSON以外の文字は一切出力しないでください`
        },
        {
          role: 'user',
          content: userMessage
        }
      ],
      temperature: 0.1,
      max_tokens: 500,
      response_format: { type: 'json_object' }
    });

    const responseText = completion.choices[0].message.content;
    console.log('🤖 OpenAI生成テキスト:', responseText);

    const analysisResult = JSON.parse(responseText);
    return analysisResult;

  } catch (error) {
    console.error('❌ OpenAI API エラー:', error);
    throw new Error(`OpenAI解析失敗: ${error.message}`);
  }
}

// Googleカレンダーに追加
async function addToCalendar(analysisResult) {
  try {
    const event = {
      summary: analysisResult.title,
      description: analysisResult.description || '',
      start: {
        dateTime: analysisResult.start,
        timeZone: 'Asia/Tokyo',
      },
      end: {
        dateTime: analysisResult.end,
        timeZone: 'Asia/Tokyo',
      },
    };

    const response = await calendar.events.insert({
      calendarId: 'primary',
      resource: event,
    });

    console.log('✅ カレンダーに追加:', response.data.htmlLink);
    return response.data;
  } catch (error) {
    console.error('❌ カレンダー追加エラー:', error);
    throw new Error(`カレンダー追加失敗: ${error.message}`);
  }
}

// Googleタスクに追加
async function addToTasks(analysisResult) {
  try {
    // タスクリストを取得
    const taskLists = await tasks.tasklists.list();
    const taskListId = taskLists.data.items[0].id;

    const task = {
      title: analysisResult.title,
      notes: analysisResult.notes || '',
      due: analysisResult.due || null,
    };

    const response = await tasks.tasks.insert({
      tasklist: taskListId,
      resource: task,
    });

    console.log('✅ タスクに追加:', response.data.id);
    return response.data;
  } catch (error) {
    console.error('❌ タスク追加エラー:', error);
    throw new Error(`タスク追加失敗: ${error.message}`);
  }
}

// LINEプッシュメッセージ送信
async function sendPushMessage(userId, messageText) {
  try {
    await client.pushMessage(userId, {
      type: 'text',
      text: messageText
    });
    console.log('✅ プッシュメッセージ送信完了');
  } catch (error) {
    console.error('❌ プッシュメッセージ送信エラー:', error);
    throw error;
  }
}

// ヘルスチェックエンドポイント
app.get('/', (req, res) => {
  res.send('MANUS LINE Bot is running! 🚀 (OpenAI API)');
});

app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    service: 'MANUS LINE Bot',
    ai: 'OpenAI GPT-4o-mini'
  });
});

// サーバー起動
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`🚀 Server is running on port ${PORT}`);
  console.log(`✅ OpenAI API: 設定完了`);
  console.log(`✅ LINE Bot: 設定完了`);
  console.log(`✅ Google Calendar/Tasks: 設定完了`);
});
