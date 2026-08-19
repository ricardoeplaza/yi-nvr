/**
 * app.js
 * 
 * Frontend vanilla JavaScript para yi-nvr.
 * 
 * Este script maneja:
 *  - Consumo de la API REST (/api/videos, /api/cameras, /api/timeline)
 *  - Renderizado dinámico de la galería de videos
 *  - Filtrado por cámara y rango de fechas
 *  - Visualización del timeline agregado
 *  - Modal de reproducción de video
 * 
 * No utiliza frameworks externos para mantener la aplicación
 * ligera y rápida en el Orange Pi Zero 3.
 */

// Estado global de la aplicación
    const state = {
        videos: [],
        filteredVideos: [],
        cameras: [],
        currentTab: 'gallery',
        pagination: {
            currentPage: 1,
            itemsPerPage: 12,
            totalPages: 1,
            totalItems: 0
        },
        filters: {
            camera: '',
            startDate: '',
            endDate: ''
        }
    };

// Referencias a elementos DOM
    const elements = {
        cameraSelect: document.getElementById('camera-select'),
        dateStart: document.getElementById('date-start'),
        dateEnd: document.getElementById('date-end'),
        btnRefresh: document.getElementById('btn-refresh'),
        btnClear: document.getElementById('btn-clear'),
        videosGrid: document.getElementById('videos-grid'),
        timelineContainer: document.getElementById('timeline-container'),
        tabButtons: document.querySelectorAll('.tab-btn'),
        tabContents: document.querySelectorAll('.tab-content'),
        modal: document.getElementById('video-modal'),
        modalVideo: document.getElementById('modal-video'),
        modalTitle: document.getElementById('modal-title'),
        modalCamera: document.getElementById('modal-camera'),
        modalDate: document.getElementById('modal-date'),
        modalDuration: document.getElementById('modal-duration'),
        modalSize: document.getElementById('modal-size'),
        closeBtn: document.querySelector('.close-btn'),
        paginationControls: document.getElementById('pagination-controls'),
        prevPageBtn: document.getElementById('prev-page'),
        nextPageBtn: document.getElementById('next-page'),
        pageInfo: document.getElementById('page-info')
    };

// ============================================
// FUNCIONES DE API
// ============================================

/**
 * Realiza una petición fetch genérica.
 * @param {string} url - Endpoint relativo
 * @returns {Promise} - Datos JSON de la respuesta
 */
async function apiGet(url) {
    try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        return data;
    } catch (error) {
        console.error('Error en API:', error.message);
        throw error;
    }
}

/**
 * Obtiene la lista de videos desde el servidor.
 * @param {Object} filters - Filtros opcionales
 */
async function fetchVideos(filters = {}) {
    const params = new URLSearchParams();
    if (filters.camera) params.append('camera', filters.camera);
    if (filters.startDate) params.append('startDate', filters.startDate);
    if (filters.endDate) params.append('endDate', filters.endDate);
    
    const queryString = params.toString() ? `?${params.toString()}` : '';
    const data = await apiGet(`/api/videos${queryString}`);
    return data.data || [];
}

/**
 * Obtiene la lista de cámaras disponibles.
 */
async function fetchCameras() {
    const data = await apiGet('/api/cameras');
    return data.data || [];
}

/**
 * Obtiene los datos del timeline.
 */
async function fetchTimeline() {
    const data = await apiGet('/api/timeline');
    return data.data || [];
}

/**
 * Elimina un video del servidor.
 * @param {number} id - ID del video a eliminar
 */
async function deleteVideo(id) {
    try {
        const response = await fetch(`/api/videos/${id}`, {
            method: 'DELETE'
        });
        
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        return data;
    } catch (error) {
        console.error('Error eliminando video:', error.message);
        throw error;
    }
}

// ============================================
// FUNCIONES DE RENDERIZADO
// ============================================

/**
 * Formatea una fecha ISO a formato legible.
 * @param {string} isoDate - Fecha en formato ISO
 * @returns {string} - Fecha formateada
 */
function formatDate(isoDate) {
    const date = new Date(isoDate);
    return date.toLocaleString('es-ES', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
    });
}

/**
 * Formatea tamaño de archivo en bytes a unidad legible.
 * @param {number} bytes - Tamaño en bytes
 * @returns {string} - Tamaño formateado (KB, MB, GB)
 */
function formatSize(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * Formatea duración en segundos a formato mm:ss.
 * @param {number} seconds - Segundos
 * @returns {string} - Duración formateada
 */
function formatDuration(seconds) {
    if (!seconds) return 'N/A';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
}

/**
 * Aplica paginación a la lista de videos.
 * @returns {Array} - Videos de la página actual
 */
    function applyPagination() {
        const { currentPage, itemsPerPage, totalItems } = state.pagination;
        
        const startIndex = (currentPage - 1) * itemsPerPage;
        const endIndex = startIndex + itemsPerPage;
        const paginatedVideos = state.filteredVideos.slice(startIndex, endIndex);
        
        return paginatedVideos;
    }

/**
 * Renderiza la galería de videos en el grid.
 */
    function renderGallery(videos) {
        if (videos.length === 0) {
            elements.videosGrid.innerHTML = '<div class="empty-state">No hay videos disponibles</div>';
            updatePaginationControls();
            return;
        }

        elements.videosGrid.innerHTML = videos.map(video => `
            <div class="video-card" data-id="${video.id}">
                <div class="video-thumbnail">
                    ${video.preview_url 
                        ? `<img src="${video.preview_url}" alt="Preview" loading="lazy" class="preview-img">`
                        : `<div class="no-preview">Sin preview</div>`
                    }
                    <div class="play-overlay">▶</div>
                    <button class="delete-btn" data-id="${video.id}" title="Eliminar video">✕</button>
                </div>
                <div class="video-info">
                    <h3 class="video-title">${video.camera_name}</h3>
                    <p class="video-date">${formatDate(video.timestamp)}</p>
                    <p class="video-meta">
                        <span>${formatDuration(video.duration)}</span>
                        <span>${formatSize(video.file_size)}</span>
                    </p>
                </div>
            </div>
        `).join('');

        // Añadimos event listeners a cada tarjeta para abrir el modal
        document.querySelectorAll('.video-card').forEach(card => {
            card.addEventListener('click', (e) => {
                // No abrimos el modal si se hizo click en el botón de eliminar
                if (e.target.classList.contains('delete-btn')) return;
                const videoId = parseInt(card.dataset.id, 10);
                openVideoModal(videoId);
            });
        });

        // Añadimos event listeners a los botones de eliminar
        document.querySelectorAll('.delete-btn').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const videoId = parseInt(btn.dataset.id, 10);
                
                if (confirm('¿Estás seguro de que quieres eliminar este video?\n\nEsta acción no se puede deshacer.')) {
                    try {
                        btn.disabled = true;
                        btn.textContent = '...';
                        await deleteVideo(videoId);
                        
                        // Eliminamos la tarjeta del DOM
                        const card = btn.closest('.video-card');
                        card.style.opacity = '0';
                        card.style.transform = 'scale(0.8)';
                        setTimeout(() => card.remove(), 300);
                        
                        // Actualizamos el estado
                        state.filteredVideos = state.filteredVideos.filter(v => v.id !== videoId);
                        state.videos = state.filteredVideos;
                        state.pagination.totalItems = state.filteredVideos.length;
                        state.pagination.totalPages = Math.ceil(state.pagination.totalItems / state.pagination.itemsPerPage);
                        
                        if (state.pagination.currentPage > state.pagination.totalPages) {
                            state.pagination.currentPage = state.pagination.totalPages;
                        }
                        
                        updatePaginationControls();
                        renderGallery(applyPagination());
                        
                    } catch (error) {
                        alert('Error al eliminar el video: ' + error.message);
                        btn.disabled = false;
                        btn.textContent = '✕';
                    }
                }
            });
        });
    }

/**
 * Actualiza los controles de paginación.
 */
    function updatePaginationControls() {
        const { currentPage, totalPages } = state.pagination;
        
        elements.prevPageBtn.disabled = currentPage <= 1;
        elements.nextPageBtn.disabled = currentPage >= totalPages;
        elements.pageInfo.textContent = `Página ${currentPage} de ${totalPages}`;
        
        // Mostrar u ocultar controles según si hay paginación
        if (totalPages <= 1) {
            elements.paginationControls.style.display = 'none';
        } else {
            elements.paginationControls.style.display = 'flex';
        }
    }

/**
 * Renderiza el timeline de videos agrupados por fecha.
 */
function renderTimeline(timelineData) {
    if (timelineData.length === 0) {
        elements.timelineContainer.innerHTML = '<div class="empty-state">No hay datos de timeline</div>';
        return;
    }

    elements.timelineContainer.innerHTML = timelineData.map(day => `
        <div class="timeline-item">
            <div class="timeline-date">
                <span class="date-badge">${day.date}</span>
                <span class="total-badge">${day.total} videos</span>
            </div>
            <div class="timeline-cameras">
                ${Object.entries(day.cameras).map(([camera, count]) => `
                    <div class="camera-badge">
                        <span class="camera-name">${camera}</span>
                        <span class="camera-count">${count}</span>
                    </div>
                `).join('')}
            </div>
        </div>
    `).join('');
}

/**
 * Actualiza el selector de cámaras con las disponibles.
 */
function updateCameraSelect(cameras) {
    const currentValue = elements.cameraSelect.value;
    elements.cameraSelect.innerHTML = '<option value="">Todas las cámaras</option>';
    
    cameras.forEach(camera => {
        const option = document.createElement('option');
        option.value = camera;
        option.textContent = camera;
        elements.cameraSelect.appendChild(option);
    });
    
    // Restauramos la selección previa si existe
    if (currentValue && cameras.includes(currentValue)) {
        elements.cameraSelect.value = currentValue;
    }
}

// ============================================
// FUNCIONES DEL MODAL
// ============================================

/**
 * Abre el modal con el video seleccionado.
 * @param {number} videoId - ID del video
 */
function openVideoModal(videoId) {
    const video = state.videos.find(v => v.id === videoId);
    if (!video) return;

    elements.modalTitle.textContent = `Video #${video.id}`;
    elements.modalCamera.textContent = video.camera_name;
    elements.modalDate.textContent = formatDate(video.timestamp);
    elements.modalDuration.textContent = formatDuration(video.duration);
    elements.modalSize.textContent = formatSize(video.file_size);
    
    // Configuramos la fuente del video
    elements.modalVideo.src = video.original_url;
    elements.modalVideo.load();
    
    elements.modal.style.display = 'flex';
}

/**
 * Cierra el modal de video.
 */
function closeVideoModal() {
    elements.modal.style.display = 'none';
    elements.modalVideo.pause();
    elements.modalVideo.src = '';
}

// ============================================
// MANEJADORES DE EVENTOS
// ============================================

/**
 * Maneja el cambio de pestañas (Galería / Timeline).
 */
function handleTabChange(e) {
    const tabName = e.target.dataset.tab;
    if (!tabName) return;

    // Actualizamos estado visual de los tabs
    elements.tabButtons.forEach(btn => btn.classList.remove('active'));
    e.target.classList.add('active');

    // Mostramos el contenido correspondiente
    elements.tabContents.forEach(content => {
        content.classList.toggle('active', content.id === `${tabName}-view`);
    });

    state.currentTab = tabName;

    // Cargamos datos si es necesario
    if (tabName === 'timeline') {
        loadTimeline();
    }
}

/**
 * Aplica los filtros y recarga la galería.
 */
    async function handleRefresh() {
        state.filters.camera = elements.cameraSelect.value;
        state.filters.startDate = elements.dateStart.value;
        state.filters.endDate = elements.dateEnd.value;

        elements.videosGrid.innerHTML = '<div class="loading">Cargando videos...</div>';
        elements.paginationControls.style.display = 'none';
        
        try {
            const allVideos = await fetchVideos(state.filters);
            state.filteredVideos = allVideos;
            state.videos = allVideos;
            state.pagination.totalItems = allVideos.length;
            state.pagination.currentPage = 1;
            state.pagination.totalPages = Math.ceil(allVideos.length / state.pagination.itemsPerPage);
            
            renderGallery(applyPagination());
            updatePaginationControls();
        } catch (error) {
            elements.videosGrid.innerHTML = '<div class="error">Error al cargar videos</div>';
        }
    }

/**
 * Limpia los filtros y recarga todo.
 */
async function handleClear() {
    elements.cameraSelect.value = '';
    elements.dateStart.value = '';
    elements.dateEnd.value = '';
    state.filters = { camera: '', startDate: '', endDate: '' };
    await handleRefresh();
}

// ============================================
// FUNCIONES DE CARGA INICIAL
// ============================================

/**
 * Carga los videos iniciales.
 */
    async function loadVideos() {
        try {
            const allVideos = await fetchVideos();
            state.filteredVideos = allVideos;
            state.videos = allVideos;
            state.pagination.totalItems = allVideos.length;
            state.pagination.totalPages = Math.ceil(allVideos.length / state.pagination.itemsPerPage);
            renderGallery(applyPagination());
            updatePaginationControls();
        } catch (error) {
            elements.videosGrid.innerHTML = '<div class="error">Error al cargar videos</div>';
        }
    }

/**
 * Carga la lista de cámaras disponibles.
 */
async function loadCameras() {
    try {
        state.cameras = await fetchCameras();
        updateCameraSelect(state.cameras);
    } catch (error) {
        console.error('Error al cargar cámaras:', error.message);
    }
}

/**
 * Carga los datos del timeline.
 */
async function loadTimeline() {
    elements.timelineContainer.innerHTML = '<div class="loading">Cargando timeline...</div>';
    
    try {
        const timelineData = await fetchTimeline();
        renderTimeline(timelineData);
    } catch (error) {
        elements.timelineContainer.innerHTML = '<div class="error">Error al cargar timeline</div>';
    }
}

/**
 * Inicializa la aplicación.
 */
    async function init() {
        // Configuramos event listeners
        elements.tabButtons.forEach(btn => {
            btn.addEventListener('click', handleTabChange);
        });
        
        elements.btnRefresh.addEventListener('click', handleRefresh);
        elements.btnClear.addEventListener('click', handleClear);
        elements.closeBtn.addEventListener('click', closeVideoModal);
        elements.prevPageBtn.addEventListener('click', () => {
            if (state.pagination.currentPage > 1) {
                state.pagination.currentPage--;
                renderGallery(applyPagination());
                updatePaginationControls();
            }
        });
        elements.nextPageBtn.addEventListener('click', () => {
            if (state.pagination.currentPage < state.pagination.totalPages) {
                state.pagination.currentPage++;
                renderGallery(applyPagination());
                updatePaginationControls();
            }
        });
        
        // Cerrar modal al hacer click fuera del contenido
        elements.modal.addEventListener('click', (e) => {
            if (e.target === elements.modal) closeVideoModal();
        });
        
        // Cerrar modal con tecla Escape
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && elements.modal.style.display === 'flex') {
                closeVideoModal();
            }
        });

        // Cargamos datos iniciales
        await Promise.all([
            loadCameras(),
            loadVideos()
        ]);
    }

// Iniciamos la aplicación cuando el DOM esté listo
document.addEventListener('DOMContentLoaded', init);
