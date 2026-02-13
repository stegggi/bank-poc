import os
import asyncio
from dotenv import load_dotenv

from db import connect
from ethereal_bot import UC5Bot

async def main():
  load_dotenv()

  db_path = os.getenv("DB_PATH", "/home/ubuntu/uc5-bot.sqlite")
  conn = connect(db_path)

  bot = UC5Bot(conn)
  await bot.start()
  await bot.loop()

if __name__ == "__main__":
  asyncio.run(main())
