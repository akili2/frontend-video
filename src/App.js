import React, { useState, useEffect, useRef } from 'react';
import './App.css';
import io from 'socket.io-client';

const SOCKET_SERVER_URL = process.env.REACT_APP_SOCKET_URL || 'http://localhost:5000';

function VideoCallApp() {
  // États
  const [appState, setAppState] = useState({
    status: 'idle', // idle, creating, waiting, joining, in-call, error
    callCode: '',
    inputCode: '',
    error: '',
    isCreator: false,
    participants: 0,
    connectionStatus: 'disconnected'
  });

  // Références
  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const peerConnectionRef = useRef(null);
  const localStreamRef = useRef(null);
  const socketRef = useRef(null);
  const configurationRef = useRef({
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
      { urls: 'stun:stun3.l.google.com:19302' },
      { urls: 'stun:stun4.l.google.com:19302' },
      // Serveurs TURN gratuits
      {
        urls: 'turn:openrelay.metered.ca:80',
        username: 'openrelayproject',
        credential: 'openrelayproject'
      },
      {
        urls: 'turn:openrelay.metered.ca:443',
        username: 'openrelayproject',
        credential: 'openrelayproject'
      },
      {
        urls: 'turn:openrelay.metered.ca:443?transport=tcp',
        username: 'openrelayproject',
        credential: 'openrelayproject'
      }
    ],
    iceCandidatePoolSize: 10,
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require'
  });

  // Initialisation
  useEffect(() => {
    initializeApp();
    return cleanup;
  }, []);

  const initializeApp = async () => {
    try {
      // Initialiser Socket.io
      const socket = io(SOCKET_SERVER_URL, {
        transports: ['websocket', 'polling'],
        reconnection: true,
        reconnectionAttempts: 10,
        reconnectionDelay: 1000
      });

      socketRef.current = socket;

      // Événements Socket.io
      socket.on('connect', () => {
        console.log('✅ Socket connecté:', socket.id);
        updateState({ connectionStatus: 'connected' });
      });

      socket.on('disconnect', () => {
        console.log('❌ Socket déconnecté');
        updateState({ connectionStatus: 'disconnected' });
      });

      socket.on('call-created', handleCallCreated);
      socket.on('call-joined', handleCallJoined);
      socket.on('participant-joined', handleParticipantJoined);
      socket.on('participant-left', handleParticipantLeft);
      socket.on('webrtc-offer', handleWebRTCOffer);
      socket.on('webrtc-answer', handleWebRTCAnswer);
      socket.on('webrtc-ice-candidate', handleWebRTCIceCandidate);
      socket.on('error', handleError);

      // Initialiser la caméra
      await initializeMedia();

    } catch (error) {
      console.error('Erreur initialisation:', error);
      updateState({ 
        error: 'Erreur lors de l\'initialisation',
        status: 'error' 
      });
    }
  };

  const initializeMedia = async () => {
    try {
      const constraints = {
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 30 }
        },
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      };

      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      localStreamRef.current = stream;

      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
      }

      console.log('✅ Média initialisé');
    } catch (error) {
      console.error('❌ Erreur média:', error);
      updateState({ 
        error: 'Impossible d\'accéder à la caméra/microphone',
        status: 'error' 
      });
    }
  };

  // Créer un appel
  const createCall = async () => {
    updateState({ status: 'creating', error: '' });
    
    if (!localStreamRef.current) {
      await initializeMedia();
    }
    
    if (socketRef.current) {
      socketRef.current.emit('create-call');
    }
  };

  // Rejoindre un appel
  const joinCall = async () => {
    const code = appState.inputCode.trim().toUpperCase();
    
    if (code.length !== 6) {
      updateState({ error: 'Le code doit contenir 6 caractères' });
      return;
    }

    updateState({ status: 'joining', error: '' });
    
    if (!localStreamRef.current) {
      await initializeMedia();
    }
    
    if (socketRef.current) {
      socketRef.current.emit('join-call', { callCode: code });
    }
  };

  // Gestionnaires d'événements
  const handleCallCreated = (data) => {
    console.log('📞 Appel créé:', data);
    updateState({
      status: 'waiting',
      callCode: data.callCode,
      isCreator: true,
      participants: 1
    });
    
    // Démarrer le heartbeat
    startHeartbeat(data.callCode);
  };

  const handleCallJoined = (data) => {
    console.log('✅ Appel rejoint:', data);
    updateState({
      status: 'in-call',
      callCode: data.callCode,
      isCreator: false,
      participants: 2
    });
    
    // Créer la connexion Peer
    createPeerConnection(data.creatorId);
    
    // Démarrer le heartbeat
    startHeartbeat(data.callCode);
  };

  const handleParticipantJoined = (data) => {
    console.log('👤 Participant joint:', data);
    updateState({
      status: 'in-call',
      participants: 2
    });
    
    // Créer et envoyer l'offre
    createPeerConnection(data.participantId);
    setTimeout(() => sendOffer(data.participantId), 500);
  };

  const handleParticipantLeft = () => {
    console.log('🚪 Participant parti');
    updateState({
      status: 'waiting',
      participants: 1,
      error: 'Le participant a quitté l\'appel'
    });
    
    // Fermer la connexion Peer
    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }
  };

  // WebRTC Functions
  const createPeerConnection = (targetId) => {
    console.log('🔗 Création PeerConnection pour:', targetId);
    
    try {
      // Fermer l'ancienne connexion
      if (peerConnectionRef.current) {
        peerConnectionRef.current.close();
      }

      const pc = new RTCPeerConnection(configurationRef.current);
      peerConnectionRef.current = pc;
      peerConnectionRef.current.targetId = targetId;

      // Ajouter le stream local
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach(track => {
          pc.addTrack(track, localStreamRef.current);
        });
      }

      // Gérer les candidats ICE
      pc.onicecandidate = (event) => {
        if (event.candidate && socketRef.current) {
          socketRef.current.emit('webrtc-ice-candidate', {
            callCode: appState.callCode,
            candidate: event.candidate,
            to: targetId
          });
        }
      };

      // Gérer les changements d'état
      pc.oniceconnectionstatechange = () => {
        console.log('🔄 ICE State:', pc.iceConnectionState);
        
        switch(pc.iceConnectionState) {
          case 'connected':
          case 'completed':
            console.log('✅ Connexion WebRTC établie!');
            updateState({ error: '' });
            break;
          case 'failed':
            console.error('❌ Échec connexion ICE');
            updateState({ error: 'Connexion échouée. Réessayez.' });
            break;
        }
      };

      // Recevoir le stream distant
      pc.ontrack = (event) => {
        console.log('🎬 Stream distant reçu');
        
        if (event.streams && event.streams[0] && remoteVideoRef.current) {
          const remoteStream = event.streams[0];
          remoteVideoRef.current.srcObject = remoteStream;
          
          // Forcer la lecture
          remoteVideoRef.current.play().catch(e => {
            console.warn('⚠️ Erreur lecture vidéo:', e);
          });
        }
      };

      pc.onnegotiationneeded = async () => {
        console.log('🔄 Négociation nécessaire');
        await sendOffer(targetId);
      };

      console.log('✅ PeerConnection créée');
      return pc;

    } catch (error) {
      console.error('❌ Erreur création PeerConnection:', error);
      return null;
    }
  };

  const sendOffer = async (targetId) => {
    const pc = peerConnectionRef.current;
    if (!pc) return;

    try {
      const offer = await pc.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: true
      });
      
      await pc.setLocalDescription(offer);
      
      socketRef.current.emit('webrtc-offer', {
        callCode: appState.callCode,
        offer: pc.localDescription,
        to: targetId
      });
      
      console.log('📤 Offre envoyée à:', targetId);
    } catch (error) {
      console.error('❌ Erreur envoi offre:', error);
    }
  };

  const handleWebRTCOffer = async (data) => {
    console.log('📥 Offre reçue de:', data.from);
    
    if (!peerConnectionRef.current) {
      createPeerConnection(data.from);
    }
    
    const pc = peerConnectionRef.current;
    if (!pc) return;
    
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
      
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      
      socketRef.current.emit('webrtc-answer', {
        callCode: appState.callCode,
        answer: pc.localDescription,
        to: data.from
      });
      
      console.log('📤 Réponse envoyée à:', data.from);
    } catch (error) {
      console.error('❌ Erreur traitement offre:', error);
    }
  };

  const handleWebRTCAnswer = async (data) => {
    console.log('📥 Réponse reçue de:', data.from);
    
    const pc = peerConnectionRef.current;
    if (!pc) return;
    
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
      console.log('✅ Réponse traitée');
    } catch (error) {
      console.error('❌ Erreur traitement réponse:', error);
    }
  };

  const handleWebRTCIceCandidate = async (data) => {
    const pc = peerConnectionRef.current;
    if (!pc || !data.candidate) return;
    
    try {
      await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
      console.log('✅ Candidat ICE ajouté');
    } catch (error) {
      console.error('❌ Erreur ajout ICE:', error);
    }
  };

  const handleError = (data) => {
    console.error('❌ Erreur serveur:', data);
    updateState({ 
      error: data.message || 'Erreur de connexion',
      status: 'error' 
    });
  };

  // Utilitaires
  const updateState = (updates) => {
    setAppState(prev => ({ ...prev, ...updates }));
  };

  const startHeartbeat = (callCode) => {
    const interval = setInterval(() => {
      if (socketRef.current && appState.status === 'in-call') {
        socketRef.current.emit('heartbeat', { callCode });
      } else {
        clearInterval(interval);
      }
    }, 30000); // Toutes les 30 secondes
  };

  const endCall = () => {
    if (socketRef.current && appState.callCode) {
      socketRef.current.emit('leave-call', { callCode: appState.callCode });
    }
    
    cleanup();
    resetApp();
  };

  const cleanup = () => {
    // Fermer PeerConnection
    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }
    
    // Arrêter les streams
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(track => track.stop());
      localStreamRef.current = null;
    }
    
    // Nettoyer les vidéos
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = null;
    }
    
    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = null;
    }
  };

  const resetApp = () => {
    updateState({
      status: 'idle',
      callCode: '',
      inputCode: '',
      error: '',
      isCreator: false,
      participants: 0
    });
  };

  const copyCallCode = () => {
    navigator.clipboard.writeText(appState.callCode);
    alert('Code copié dans le presse-papier !');
  };

  const toggleCamera = () => {
    if (localStreamRef.current) {
      const videoTrack = localStreamRef.current.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.enabled = !videoTrack.enabled;
      }
    }
  };

  const toggleMicrophone = () => {
    if (localStreamRef.current) {
      const audioTrack = localStreamRef.current.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.enabled = !audioTrack.enabled;
      }
    }
  };

  return (
    <div className="video-call-app">
      {/* Header */}
      <header className="app-header">
        <div className="header-content">
          <h1 className="app-title">📹 VideoConnect Pro</h1>
          <div className="connection-status">
            <span className={`status-indicator ${appState.connectionStatus}`}>
              {appState.connectionStatus === 'connected' ? '✅ En ligne' : '❌ Hors ligne'}
            </span>
            {appState.callCode && (
              <span className="call-code-badge">Code: {appState.callCode}</span>
            )}
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="app-main">
        {appState.error && (
          <div className="error-alert">
            <span className="error-icon">⚠️</span>
            <span>{appState.error}</span>
          </div>
        )}

        {/* Écran principal */}
        {appState.status === 'idle' && (
          <div className="home-screen">
            <div className="welcome-section">
              <h2>Appels Vidéo Sécurisés</h2>
              <p>Créez ou rejoignez un appel privé avec un code à 6 caractères</p>
            </div>

            <div className="preview-section">
              <div className="video-preview">
                <video
                  ref={localVideoRef}
                  autoPlay
                  muted
                  playsInline
                  className="preview-video"
                />
                <div className="preview-label">Votre caméra</div>
              </div>
            </div>

            <div className="action-buttons">
              <button 
                className="btn-primary btn-create"
                onClick={createCall}
                disabled={appState.status === 'creating'}
              >
                {appState.status === 'creating' ? (
                  <>
                    <span className="spinner-small"></span>
                    Création...
                  </>
                ) : (
                  '📞 Créer un nouvel appel'
                )}
              </button>

              <div className="divider">
                <span>OU</span>
              </div>

              <div className="join-section">
                <div className="input-group">
                  <input
                    type="text"
                    placeholder="Entrez le code (ex: ABC123)"
                    value={appState.inputCode}
                    onChange={(e) => updateState({ inputCode: e.target.value.toUpperCase() })}
                    maxLength={6}
                    className="code-input"
                  />
                  <button 
                    className="btn-secondary btn-join"
                    onClick={joinCall}
                    disabled={appState.status === 'joining' || !appState.inputCode}
                  >
                    {appState.status === 'joining' ? (
                      <>
                        <span className="spinner-small"></span>
                        Connexion...
                      </>
                    ) : (
                      '🔗 Rejoindre l\'appel'
                    )}
                  </button>
                </div>
                <p className="input-hint">6 lettres/chiffres, majuscules uniquement</p>
              </div>
            </div>
          </div>
        )}

        {/* En attente de participants */}
        {appState.status === 'waiting' && (
          <div className="waiting-screen">
            <div className="waiting-content">
              <div className="waiting-header">
                <h2>⏳ En attente d'un participant...</h2>
                <p>Partagez le code ci-dessous avec la personne que vous souhaitez appeler</p>
              </div>

              <div className="call-code-display">
                <div className="code-container">
                  <span className="code-label">Code d'appel</span>
                  <div className="code-value">{appState.callCode}</div>
                </div>
                <button 
                  className="btn-copy-code"
                  onClick={copyCallCode}
                >
                  📋 Copier le code
                </button>
              </div>

              <div className="local-video-container">
                <h3>Votre caméra en direct</h3>
                <video
                  ref={localVideoRef}
                  autoPlay
                  muted
                  playsInline
                  className="waiting-video"
                />
              </div>

              <div className="waiting-stats">
                <div className="stat-item">
                  <span className="stat-label">Participants</span>
                  <span className="stat-value">{appState.participants}/2</span>
                </div>
                <div className="stat-item">
                  <span className="stat-label">Statut</span>
                  <span className="stat-value waiting">En attente</span>
                </div>
              </div>

              <button 
                className="btn-cancel"
                onClick={endCall}
              >
                ❌ Annuler l'appel
              </button>
            </div>
          </div>
        )}

        {/* En communication */}
        {appState.status === 'in-call' && (
          <div className="call-screen">
            <div className="call-header">
              <div className="call-info">
                <span className="info-item">
                  <span className="info-label">Code:</span>
                  <span className="info-value">{appState.callCode}</span>
                </span>
                <span className="info-item">
                  <span className="info-label">Participants:</span>
                  <span className="info-value">{appState.participants}/2</span>
                </span>
                <span className="info-item">
                  <span className="info-label">Rôle:</span>
                  <span className="info-value">{appState.isCreator ? 'Créateur' : 'Participant'}</span>
                </span>
              </div>
              <div className="call-timer">
                {/* Timer pourrait être ajouté ici */}
              </div>
            </div>

            <div className="video-grid">
              {/* Vidéo locale */}
              <div className="video-container local-video">
                <div className="video-header">
                  <h3>Vous {appState.isCreator && '(Créateur)'}</h3>
                  <div className="video-controls-mini">
                    <button 
                      className="control-btn"
                      onClick={toggleCamera}
                      title="Activer/Désactiver caméra"
                    >
                      📹
                    </button>
                    <button 
                      className="control-btn"
                      onClick={toggleMicrophone}
                      title="Activer/Désactiver micro"
                    >
                      🎤
                    </button>
                  </div>
                </div>
                <video
                  ref={localVideoRef}
                  autoPlay
                  muted
                  playsInline
                  className="video-feed"
                />
              </div>

              {/* Vidéo distante */}
              <div className="video-container remote-video">
                <div className="video-header">
                  <h3>Participant distant</h3>
                  <span className="connection-status-indicator">
                    {peerConnectionRef.current?.iceConnectionState === 'connected' 
                      ? '✅ Connecté' 
                      : '🔄 Connexion en cours...'}
                  </span>
                </div>
                <video
                  ref={remoteVideoRef}
                  autoPlay
                  playsInline
                  className="video-feed"
                />
                {!remoteVideoRef.current?.srcObject && (
                  <div className="video-placeholder">
                    <div className="placeholder-content">
                      <div className="loading-spinner"></div>
                      <p>En attente de la connexion vidéo...</p>
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="call-controls">
              <div className="controls-center">
                <button 
                  className="control-btn-large"
                  onClick={toggleCamera}
                  title="Caméra"
                >
                  📹
                </button>
                <button 
                  className="control-btn-large"
                  onClick={toggleMicrophone}
                  title="Microphone"
                >
                  🎤
                </button>
                <button 
                  className="control-btn-large end-call"
                  onClick={endCall}
                  title="Quitter l'appel"
                >
                  🚪
                </button>
              </div>
            </div>
          </div>
        )}
      </main>

      {/* Footer */}
      <footer className="app-footer">
        <div className="footer-content">
          <p className="footer-text">
            VideoConnect Pro • Communication sécurisée P2P • 
            <span className="tech-info"> WebRTC • Socket.io • React</span>
          </p>
          <p className="footer-status">
            Socket: {socketRef.current?.id?.substring(0, 8) || '...'} • 
            ICE: {peerConnectionRef.current?.iceConnectionState || 'non connecté'}
          </p>
        </div>
      </footer>
    </div>
  );
}

export default VideoCallApp;
