# Survillance Center

A lightweight local video surveillance bridge designed for ARM-based devices like Orange Pi. This system acts as a bridge that receives video files via FTP, processes them (generating thumbnails and previews), and provides a web-based interface to view and manage the recorded footage.

## 🚀 Features

- **FTP Receiver:** Automatically accepts video uploads from IP cameras via FTP.
- **Video Processing:** Automatically generates `.jpg` thumbnails and `.webp` animated previews for each received video using `ffmpeg`.
- **REST API:** A robust API for managing and retrieving video metadata and files.
- **Web Interface:** A static frontend to browse videos, view details, and see a timeline of recordings.
- **Efficient Storage:** Uses SQLite (with WAL mode) for fast and reliable metadata management.
- **Timeline View:** Aggregated view of recordings grouped by date and camera.

## 🛠️ Tech Stack

- **Runtime:** [Node.js](https://nodejs.org/)
- **Web Framework:** [Express](https://expressjs.com/)
- **Database:** [better-sqlite3](https://github.com/better-sqlite3/better-sqlite3) (Optimized for performance on ARM)
- **FTP Server:** [ftp-srv](https://github.com/mcollina/ftp-srv)
- **Video Processing:** [fluent-ffmpeg](https://github.com/fluent-ffmpeg/node-fluent-ffmpeg)
- **File Watching:** [chokidar](https://github.com/paul-maas/chokidar)

## 📂 Project Structure

```text
survillance-center/
├── src/
│   ├── server.js          # Main entry point
│   ├── ftp.js              # FTP server logic
│   ├── database.js         # SQLite database management
│   └── storage/            # Persistent data storage
│       ├── surveillance.db # SQLite database file
│       ├── ftp/            # Original .mp4 files
│       └── processed/      # Thumbnails and previews
├── public/                 # Static frontend files
├── package.json            # Project dependencies and scripts
└── README.md              # Project documentation
```

## 🚀 Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (LTS recommended)
- [FFmpeg](https://ffmpeg.org/) (Must be installed on the system)

### Installation

1. Clone this repository (or navigate to the folder).
2. Install dependencies:

```bash
npm install
```

### Running the application

To start the server in development mode:

```bash
npm run dev
```

The server will start on `http://localhost:3000` by default.

## 📡 API Endpoints

### Video Management

- `GET /api/videos`: List all videos. Supports filters: `camera`, `startDate`, `endDate`, and `limit`.
- `GET /api/videos/:id`: Get detailed information for a specific video.
- `DELETE /api/videos/:id`: Permanently delete a video and its associated files.

### System Info

- `GET /api/cameras`: Get a list of all cameras that have sent videos.
- `GET /api/timeline`: Get aggregated recording data for the timeline view.

## 📝 License

[ISC](https://opensource.org/licenses/ISC)
