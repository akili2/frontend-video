import React, { useState, useEffect, useRef } from 'react';
import './App.css';
import io from 'socket.io-client';

const SOCKET_SERVER_URL = process.env.REACT_APP_SOCKET_URL || 'http://localhost:5000';

function App() {
  const [socket, setSocket] = useState(null);
  const [callCode, setCallCode] = useState('');
  const [inputCallCode, setInputCallCode] = useState('');
  const [callStatus, setCallStatus] = useState('idle'); // idle, creating, waiting, joined, in-call
  const [participants, setParticipants] = useState(0);
  const [error, setError] = useState('');
  const [isCreator, setIsCreator] = useState(false);
  const [waitingParticipants, setWaitingParticipants] = useState([]);
  const [showWaitingModal, setShowWaitingModal] = useState(false);

  // Références pour WebRTC
  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const peerConnectionRef = useRef(null);
  const localStreamRef = useRef(null);
  const socketRef = useRef(null);
  const callIdRef = useRef(null);
  const remoteStreamRef = useRef(new MediaStream());

  // Configuration WebRTC améliorée
  const configuration = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
      { urls: 'stun:stun3.l.google.com:19302' },
      { urls: 'stun:stun4.l.google.com:19302' },
      // Pour la production, ajoutez des serveurs TURN
      // {
      //   urls: 'turn:your-turn-server.com:3478',
      //   username: 'username',
      //   credential: 'password'
      // }
    ],
    iceCandidatePoolSize: 10,
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require'
  };

  useEffect(() => {
    // Initialiser Socket.io
    const newSocket = io(SOCKET_SERVER_URL, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 1000,
    });
    
    socketRef.current = newSocket;
    setSocket(newSocket);

    // Configurer les écouteurs d'événements
    newSocket.on('connect', () => {
      console.log('✅ Connecté au serveur avec ID:', newSocket.id);
    });

    newSocket.on('disconnect', () => {
      console.log('❌ Déconnecté du serveur');
    });

    newSocket.on('call-created', handleCallCreated);
    newSocket.on('call-joined', handleCallJoined);
    newSocket.on('call-not-found', handleCallNotFound);
    newSocket.on('call-full', handleCallFull);
    newSocket.on('call-waiting-for-approval', handleCallWaiting);
    newSocket.on('call-rejected', handleCallRejected);
    newSocket.on('call-busy', handleCallBusy);
    newSocket.on('participant-waiting', handleParticipantWaiting);
    newSocket.on('participant-accepted', handleParticipantAccepted);
    newSocket.on('participant-rejected', handleParticipantRejected);
    newSocket.on('participant-left', handleParticipantLeft);
    newSocket.on('receive-offer', handleReceiveOffer);
    newSocket.on('receive-answer', handleReceiveAnswer);
    newSocket.on('receive-ice-candidate', handleReceiveIceCandidate);

    // Initialiser la caméra
    initMediaDevices();

    return () => {
      newSocket.disconnect();
      cleanup();
    };
  }, []);

  // Initialiser la caméra et le microphone
  const initMediaDevices = async () => {
    try {
      console.log('🎥 Initialisation de la caméra...');
      
      const constraints = {
        video: {
          width: { ideal: 640 },
          height: { ideal: 480 },
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
        localVideoRef.current.muted = true; // Mute la vidéo locale
        console.log('✅ Caméra initialisée avec succès');
      }
    } catch (err) {
      console.error('❌ Erreur caméra:', err);
      setError('Veuillez autoriser l\'accès à la caméra et au microphone');
    }
  };

  // Créer une connexion Peer
  const createPeerConnection = () => {
    console.log('🔗 Création de la connexion Peer...');
    
    try {
      // Fermer l'ancienne connexion si elle existe
      if (peerConnectionRef.current) {
        peerConnectionRef.current.close();
      }

      const pc = new RTCPeerConnection(configuration);
      
      // Ajouter le flux local
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach(track => {
          console.log(`➕ Ajout de la piste ${track.kind}`);
          pc.addTrack(track, localStreamRef.current);
        });
      }

      // Gérer les candidats ICE
      pc.onicecandidate = (event) => {
        if (event.candidate && callCode && socketRef.current?.connected) {
          console.log('❄️ Envoi du candidat ICE');
          socketRef.current.emit('send-ice-candidate', {
            callCode,
            candidate: event.candidate
          });
        }
      };

      // Suivre l'état de la connexion ICE
      pc.oniceconnectionstatechange = () => {
        console.log(`🔄 État ICE: ${pc.iceConnectionState}`);
        
        switch(pc.iceConnectionState) {
          case 'connected':
          case 'completed':
            console.log('✅ Connexion WebRTC établie!');
            setError('');
            break;
          case 'failed':
            console.log('❌ Échec de la connexion ICE');
            setError('Échec de connexion. Réessayez...');
            break;
          case 'disconnected':
            console.log('⚠️ Connexion ICE interrompue');
            break;
        }
      };

      // Gérer les pistes reçues
      pc.ontrack = (event) => {
        console.log('🎬 Réception d\'une piste média:', event.track.kind);
        
        if (event.streams && event.streams[0]) {
          // Ajouter les pistes au stream distant
          event.streams[0].getTracks().forEach(track => {
            if (!remoteStreamRef.current.getTracks().some(t => t.id === track.id)) {
              remoteStreamRef.current.addTrack(track);
            }
          });
          
          // Assigner au lecteur vidéo
          if (remoteVideoRef.current) {
            remoteVideoRef.current.srcObject = remoteStreamRef.current;
            console.log('✅ Flux vidéo distant attaché');
          }
        }
      };

      peerConnectionRef.current = pc;
      return pc;
    } catch (err) {
      console.error('❌ Erreur création PeerConnection:', err);
      setError('Erreur technique lors de la connexion');
      return null;
    }
  };

  // Créer et envoyer une offre SDP
  const createAndSendOffer = async () => {
    console.log('📤 Création de l\'offre SDP...');
    
    const pc = peerConnectionRef.current;
    if (!pc) {
      console.error('❌ PeerConnection non initialisée');
      return;
    }

    try {
      const offerOptions = {
        offerToReceiveAudio: true,
        offerToReceiveVideo: true,
        voiceActivityDetection: false
      };

      const offer = await pc.createOffer(offerOptions);
      
      // Important: setLocalDescription avant d'envoyer
      await pc.setLocalDescription(offer);
      console.log('✅ Offre SDP créée et définie localement');
      
      // Envoyer l'offre via Socket.io
      if (socketRef.current?.connected && callCode) {
        socketRef.current.emit('send-offer', {
          callCode,
          offer
        });
        console.log('📤 Offre envoyée via Socket.io');
      }
    } catch (err) {
      console.error('❌ Erreur création offre:', err);
      setError('Erreur lors de l\'initiation de l\'appel');
    }
  };

  // Gérer les événements Socket.io
  const handleCallCreated = (data) => {
    console.log('📞 Appel créé:', data);
    setCallCode(data.callCode);
    setIsCreator(true);
    setCallStatus('waiting');
    setParticipants(1);
    setError('');
    callIdRef.current = data.callId;
    
    // Créer la PeerConnection immédiatement
    createPeerConnection();
  };

  const handleCallJoined = (data) => {
    console.log('✅ Appel rejoint:', data);
    setCallCode(inputCallCode.toUpperCase());
    setIsCreator(false);
    setCallStatus('in-call');
    setParticipants(data.participantCount || 2);
    setError('');
    callIdRef.current = data.callId;
    
    // Créer la PeerConnection pour le participant
    createPeerConnection();
  };

  const handleCallWaiting = (data) => {
    console.log('⏳ En attente d\'approbation');
    setCallStatus('waiting-approval');
    setError('⏳ En attente de l\'approbation du créateur...');
  };

  const handleCallRejected = (data) => {
    console.log('❌ Appel rejeté:', data);
    setError('❌ Le créateur a refusé votre demande');
    setCallStatus('idle');
  };

  const handleCallBusy = () => {
    setError('⏳ Un participant est déjà en attente sur cet appel');
    setCallStatus('idle');
  };

  const handleParticipantWaiting = (data) => {
    console.log('🔔 Participant en attente:', data);
    setWaitingParticipants(prev => [...prev, data.participantId]);
    setShowWaitingModal(true);
  };

  const handleParticipantAccepted = (data) => {
    console.log('✅ Participant accepté:', data);
    setParticipants(data.participantCount);
    setCallStatus('in-call');
    setError('');
    
    // Si c'est le créateur, envoyer l'offre
    if (isCreator) {
      setTimeout(() => {
        createAndSendOffer();
      }, 500);
    }
  };

  const handleParticipantRejected = (data) => {
    console.log('❌ Participant rejeté:', data);
    setWaitingParticipants(prev => prev.filter(id => id !== data.participantId));
    if (waitingParticipants.length <= 1) {
      setShowWaitingModal(false);
    }
  };

  const handleParticipantLeft = (data) => {
    console.log('🚪 Participant parti:', data);
    setParticipants(data.participantCount);
    
    if (isCreator) {
      setCallStatus('waiting');
      setError('Le participant a quitté l\'appel');
    } else {
      setError('L\'autre participant a quitté l\'appel');
      setTimeout(endCall, 3000);
    }
    
    // Nettoyer WebRTC
    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }
    
    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = null;
    }
  };

  const handleCallNotFound = () => {
    setError('❌ Code d\'appel introuvable');
    setCallStatus('idle');
  };

  const handleCallFull = () => {
    setError('❌ L\'appel est complet (2 participants maximum)');
    setCallStatus('idle');
  };

  // Gérer la réception d'une offre
  const handleReceiveOffer = async (data) => {
    console.log('📥 Offre reçue:', data);
    setCallStatus('in-call');
    setParticipants(2);
    setError('');
    
    try {
      let pc = peerConnectionRef.current;
      if (!pc) {
        pc = createPeerConnection();
      }
      
      // Vérifier l'état de la PeerConnection
      if (pc.signalingState !== 'stable') {
        console.warn('⚠️ PeerConnection pas stable, réinitialisation...');
        pc.close();
        pc = createPeerConnection();
      }
      
      // Définir l'offre distante
      await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
      console.log('✅ Description distante définie');
      
      // Créer et envoyer la réponse
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      console.log('✅ Réponse créée et définie localement');
      
      // Envoyer la réponse
      if (socketRef.current?.connected) {
        socketRef.current.emit('send-answer', {
          callCode,
          answer
        });
        console.log('📤 Réponse envoyée');
      }
    } catch (err) {
      console.error('❌ Erreur traitement offre:', err);
      setError('Erreur lors de l\'établissement de la connexion');
    }
  };

  // Gérer la réception d'une réponse
  const handleReceiveAnswer = async (data) => {
    console.log('📥 Réponse reçue:', data);
    
    const pc = peerConnectionRef.current;
    if (!pc) {
      console.error('❌ Aucune PeerConnection pour la réponse');
      return;
    }
    
    try {
      const remoteDesc = new RTCSessionDescription(data.answer);
      
      // Vérifier l'état actuel
      if (pc.signalingState !== 'have-local-offer') {
        console.warn(`⚠️ Mauvais état signaling: ${pc.signalingState}, attendu: have-local-offer`);
        // Réinitialiser et recommencer
        pc.close();
        createPeerConnection();
        return;
      }
      
      await pc.setRemoteDescription(remoteDesc);
      console.log('✅ Réponse distante définie avec succès');
    } catch (err) {
      console.error('❌ Erreur définition réponse:', err);
    }
  };

  // Gérer les candidats ICE reçus
  const handleReceiveIceCandidate = async (data) => {
    console.log('❄️ Candidat ICE reçu:', data);
    
    const pc = peerConnectionRef.current;
    if (!pc || !data.candidate) {
      console.log('⚠️ Pas de PeerConnection ou candidat vide');
      return;
    }
    
    try {
      await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
      console.log('✅ Candidat ICE ajouté');
    } catch (err) {
      console.error('❌ Erreur ajout candidat ICE:', err);
    }
  };

  // Accepter un participant
  const acceptParticipant = (participantId) => {
    if (socketRef.current && callCode) {
      socketRef.current.emit('accept-participant', {
        callCode,
        participantId
      });
      setWaitingParticipants(prev => prev.filter(id => id !== participantId));
      if (waitingParticipants.length <= 1) {
        setShowWaitingModal(false);
      }
    }
  };

  // Refuser un participant
  const rejectParticipant = (participantId) => {
    if (socketRef.current && callCode) {
      socketRef.current.emit('reject-participant', {
        callCode,
        participantId
      });
      setWaitingParticipants(prev => prev.filter(id => id !== participantId));
      if (waitingParticipants.length <= 1) {
        setShowWaitingModal(false);
      }
    }
  };

  // Créer un appel
  const createCall = () => {
    if (socketRef.current) {
      setCallStatus('creating');
      setError('');
      socketRef.current.emit('create-call');
    }
  };

  // Rejoindre un appel
  const joinCall = () => {
    const code = inputCallCode.trim().toUpperCase();
    if (code.length === 6) {
      setCallStatus('joining');
      setError('');
      socketRef.current.emit('join-call', { callCode: code });
    } else {
      setError('Le code doit contenir 6 caractères');
    }
  };

  // Quitter l'appel
  const endCall = () => {
    console.log('🚪 Fin de l\'appel');
    
    // Informer le serveur
    if (socketRef.current && callCode) {
      socketRef.current.emit('leave-call', { callCode });
    }
    
    // Nettoyer WebRTC
    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }
    
    // Nettoyer les streams
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(track => track.stop());
      localStreamRef.current = null;
    }
    
    remoteStreamRef.current.getTracks().forEach(track => track.stop());
    remoteStreamRef.current = new MediaStream();
    
    // Réinitialiser l'état
    setCallStatus('idle');
    setCallCode('');
    setInputCallCode('');
    setParticipants(0);
    setIsCreator(false);
    setWaitingParticipants([]);
    setShowWaitingModal(false);
    setError('');
    
    // Réinitialiser les vidéos
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = null;
    }
    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = null;
    }
  };

  // Nettoyage
  const cleanup = () => {
    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
    }
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(track => track.stop());
    }
    remoteStreamRef.current.getTracks().forEach(track => track.stop());
  };

  // Basculer la caméra
  const toggleCamera = () => {
    if (localStreamRef.current) {
      const videoTrack = localStreamRef.current.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.enabled = !videoTrack.enabled;
      }
    }
  };

  // Basculer le microphone
  const toggleMicrophone = () => {
    if (localStreamRef.current) {
      const audioTrack = localStreamRef.current.getAudioTracks()[0];
      if (audioTrack) {
        audioTrack.enabled = !audioTrack.enabled;
      }
    }
  };

  return (
    <div className="App">
      <header className="App-header">
        <h1>🎥 Appel Vidéo WebRTC</h1>
        <p>Connexion P2P sécurisée avec code secret</p>
      </header>

      <main className="App-main">
        {error && (
          <div className={`message ${error.includes('❌') ? 'error' : 'info'}`}>
            {error}
          </div>
        )}

        {/* Modal d'attente */}
        {showWaitingModal && (
          <div className="modal-overlay">
            <div className="modal">
              <h3>🔔 Demande de connexion</h3>
              <p>Un participant souhaite rejoindre votre appel</p>
              
              {waitingParticipants.map(participantId => (
                <div key={participantId} className="waiting-participant">
                  <p>Participant: <code>{participantId.substring(0, 8)}...</code></p>
                  <div className="modal-buttons">
                    <button 
                      className="btn-accept"
                      onClick={() => acceptParticipant(participantId)}
                    >
                      ✅ Accepter
                    </button>
                    <button 
                      className="btn-reject"
                      onClick={() => rejectParticipant(participantId)}
                    >
                      ❌ Refuser
                    </button>
                  </div>
                </div>
              ))}
              
              <button 
                className="btn-close-modal"
                onClick={() => setShowWaitingModal(false)}
              >
                Fermer
              </button>
            </div>
          </div>
        )}

        {callStatus === 'idle' && (
          <div className="call-actions">
            <div className="action-card">
              <h2>📞 Créer un appel</h2>
              <button className="btn-create" onClick={createCall}>
                Créer un nouvel appel
              </button>
            </div>
            
            <div className="divider">
              <span>OU</span>
            </div>
            
            <div className="action-card">
              <h2>🔗 Rejoindre un appel</h2>
              <div className="join-input-group">
                <input
                  type="text"
                  placeholder="EX: ABC123"
                  value={inputCallCode}
                  onChange={(e) => setInputCallCode(e.target.value.toUpperCase())}
                  maxLength="6"
                  className="join-input"
                />
                <button className="btn-join" onClick={joinCall}>
                  Rejoindre
                </button>
              </div>
            </div>
          </div>
        )}

        {['creating', 'joining', 'waiting-approval'].includes(callStatus) && (
          <div className="loading">
            <div className="spinner"></div>
            <p>
              {callStatus === 'creating' && 'Création de l\'appel...'}
              {callStatus === 'joining' && 'Connexion à l\'appel...'}
              {callStatus === 'waiting-approval' && 'En attente d\'approbation...'}
            </p>
          </div>
        )}

        {callStatus === 'waiting' && (
          <div className="waiting-room">
            <h2>⏳ En attente d'un participant...</h2>
            <div className="call-code-display">
              <p>Code d'appel :</p>
              <h1>{callCode}</h1>
              <p>Partagez ce code avec votre contact</p>
              <button 
                className="btn-copy"
                onClick={() => navigator.clipboard.writeText(callCode)}
              >
                📋 Copier le code
              </button>
            </div>
            
            <div className="local-preview">
              <h3>Votre caméra :</h3>
              <video
                ref={localVideoRef}
                autoPlay
                muted
                playsInline
                className="preview-video"
              />
            </div>
            
            <button className="btn-end" onClick={endCall}>
              Annuler l'appel
            </button>
          </div>
        )}

        {callStatus === 'in-call' && (
          <div className="video-container">
            <div className="call-header">
              <h2>{isCreator ? '👑 Créateur' : '👤 Participant'}</h2>
              <div className="call-info">
                <span>Code: <strong>{callCode}</strong></span>
                <span>Participants: <strong>{participants}/2</strong></span>
                <span className="connection-status">
                  {peerConnectionRef.current?.iceConnectionState === 'connected' 
                    ? '✅ Connecté' 
                    : '🔄 Connexion...'}
                </span>
              </div>
            </div>
            
            <div className="video-grid">
              <div className="video-wrapper local">
                <div className="video-header">
                  <h3>Vous</h3>
                  <div className="video-controls">
                    <button onClick={toggleCamera}>📹</button>
                    <button onClick={toggleMicrophone}>🎤</button>
                  </div>
                </div>
                <video
                  ref={localVideoRef}
                  autoPlay
                  muted
                  playsInline
                  className="video-element"
                />
              </div>
              
              <div className="video-wrapper remote">
                <div className="video-header">
                  <h3>Participant distant</h3>
                  <span className="status-indicator">
                    {remoteVideoRef.current?.srcObject?.active 
                      ? '✅ Vidéo active' 
                      : '🔄 En attente...'}
                  </span>
                </div>
                <video
                  ref={remoteVideoRef}
                  autoPlay
                  playsInline
                  className="video-element"
                />
                {!remoteVideoRef.current?.srcObject && (
                  <div className="waiting-video">
                    <div className="waiting-spinner"></div>
                    <p>Connexion en cours...</p>
                  </div>
                )}
              </div>
            </div>
            
            <div className="call-controls">
              <button className="btn-end" onClick={endCall}>
                🚪 Quitter l'appel
              </button>
            </div>
          </div>
        )}
      </main>

      <footer className="App-footer">
        <p>WebRTC Video Call • {socket?.connected ? '✅ Connecté' : '❌ Déconnecté'}</p>
      </footer>
    </div>
  );
}

export default App;
