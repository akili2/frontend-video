import React, { useState, useEffect, useRef } from 'react';
import './App.css';
import io from 'socket.io-client';

const SOCKET_SERVER_URL = process.env.REACT_APP_SOCKET_URL || 'http://localhost:5000';

function App() {
  // États
  const [socket, setSocket] = useState(null);
  const [callCode, setCallCode] = useState('');
  const [inputCallCode, setInputCallCode] = useState('');
  const [callStatus, setCallStatus] = useState('idle'); // idle, waiting, in-call
  const [error, setError] = useState('');
  const [isCreator, setIsCreator] = useState(false);
  const [showWaitingModal, setShowWaitingModal] = useState(false);
  const [waitingParticipantId, setWaitingParticipantId] = useState(null);
  const [connectionStatus, setConnectionStatus] = useState('disconnected');
  
  // Références
  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const peerConnection = useRef(null);
  const localStream = useRef(null);
  const socketRef = useRef(null);
  const configuration = useRef({
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
      { urls: 'stun:stun3.l.google.com:19302' },
      // Ajoutez ces serveurs TURN gratuits
      {
        urls: 'turn:numb.viagenie.ca',
        credential: 'muazkh',
        username: 'webrtc@live.com'
      },
      {
        urls: 'turn:openrelay.metered.ca:80',
        username: 'openrelayproject',
        credential: 'openrelayproject'
      },
      {
        urls: 'turn:openrelay.metered.ca:443',
        username: 'openrelayproject',
        credential: 'openrelayproject'
      }
    ]
  });

  // Initialisation Socket.io
  useEffect(() => {
    console.log('Initialisation de Socket.io...');
    const newSocket = io(SOCKET_SERVER_URL, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      reconnectionAttempts: Infinity
    });

    socketRef.current = newSocket;
    setSocket(newSocket);

    // Événements Socket.io
    newSocket.on('connect', () => {
      console.log('✅ Socket.io connecté:', newSocket.id);
      setConnectionStatus('connected');
    });

    newSocket.on('disconnect', () => {
      console.log('❌ Socket.io déconnecté');
      setConnectionStatus('disconnected');
    });

    newSocket.on('call-created', (data) => {
      console.log('📞 Appel créé:', data);
      setCallCode(data.callCode);
      setIsCreator(true);
      setCallStatus('waiting');
      setError('');
      initLocalStream();
    });

    newSocket.on('call-joined', (data) => {
      console.log('✅ Appel rejoint:', data);
      setCallStatus('in-call');
      setError('');
      initLocalStream().then(() => {
        if (!isCreator) {
          // Si c'est un participant, on attend l'offre du créateur
          console.log('⏳ En attente de l\'offre du créateur...');
        }
      });
    });

    newSocket.on('call-not-found', () => {
      setError('❌ Code d\'appel introuvable');
      setCallStatus('idle');
    });

    newSocket.on('call-full', () => {
      setError('❌ L\'appel est complet');
      setCallStatus('idle');
    });

    newSocket.on('participant-waiting', (data) => {
      console.log('🔔 Participant en attente:', data);
      setWaitingParticipantId(data.participantId);
      setShowWaitingModal(true);
    });

    newSocket.on('participant-accepted', (data) => {
      console.log('✅ Participant accepté:', data);
      setShowWaitingModal(false);
      setWaitingParticipantId(null);
      setCallStatus('in-call');
      
      if (isCreator) {
        // Créateur: créer et envoyer l'offre
        setTimeout(() => {
          createPeerConnection();
          createAndSendOffer();
        }, 1000);
      }
    });

    newSocket.on('receive-offer', async (data) => {
      console.log('📥 Offre reçue:', data);
      if (!isCreator) {
        // Participant: traiter l'offre du créateur
        await handleReceivedOffer(data.offer);
      }
    });

    newSocket.on('receive-answer', async (data) => {
      console.log('📥 Réponse reçue:', data);
      if (isCreator && peerConnection.current) {
        await handleReceivedAnswer(data.answer);
      }
    });

    newSocket.on('receive-ice-candidate', async (data) => {
      console.log('❄️ Candidat ICE reçu:', data);
      if (peerConnection.current && data.candidate) {
        try {
          await peerConnection.current.addIceCandidate(new RTCIceCandidate(data.candidate));
          console.log('✅ Candidat ICE ajouté');
        } catch (err) {
          console.error('❌ Erreur ajout ICE:', err);
        }
      }
    });

    newSocket.on('participant-left', () => {
      console.log('🚪 Participant parti');
      setCallStatus('waiting');
      setError('Le participant a quitté l\'appel');
      if (peerConnection.current) {
        peerConnection.current.close();
        peerConnection.current = null;
      }
      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = null;
      }
    });

    return () => {
      cleanup();
      newSocket.disconnect();
    };
  }, []);

  // Initialiser le flux local
  const initLocalStream = async () => {
    try {
      if (localStream.current) {
        // Si déjà initialisé, réutiliser
        if (localVideoRef.current) {
          localVideoRef.current.srcObject = localStream.current;
        }
        return;
      }

      console.log('🎥 Demande d\'accès média...');
      const stream = await navigator.mediaDevices.getUserMedia({
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
      });

      localStream.current = stream;
      
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
        localVideoRef.current.muted = true;
        console.log('✅ Flux local initialisé');
      }

      return stream;
    } catch (err) {
      console.error('❌ Erreur accès média:', err);
      setError('Impossible d\'accéder à la caméra/microphone');
      return null;
    }
  };

  // Créer la connexion Peer
  const createPeerConnection = () => {
    console.log('🔗 Création PeerConnection...');
    
    try {
      // Fermer l'ancienne connexion si elle existe
      if (peerConnection.current) {
        peerConnection.current.close();
      }

      const pc = new RTCPeerConnection(configuration.current);
      
      // Ajouter le flux local
      if (localStream.current) {
        localStream.current.getTracks().forEach(track => {
          pc.addTrack(track, localStream.current);
          console.log(`➕ Ajout piste ${track.kind}`);
        });
      }

      // Gérer les candidats ICE
      pc.onicecandidate = (event) => {
        if (event.candidate && socketRef.current) {
          console.log('❄️ Envoi candidat ICE');
          socketRef.current.emit('send-ice-candidate', {
            callCode,
            candidate: event.candidate
          });
        }
      };

      // Suivre l'état ICE
      pc.oniceconnectionstatechange = () => {
        console.log(`🔄 État ICE: ${pc.iceConnectionState}`);
        if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
          console.log('✅ Connexion WebRTC établie!');
          setError('');
        } else if (pc.iceConnectionState === 'failed') {
          console.error('❌ Échec connexion ICE');
          setError('Échec de connexion. Essayez de rafraîchir.');
        }
      };

      // Recevoir le flux distant
      pc.ontrack = (event) => {
        console.log('🎬 Réception flux distant:', event.streams.length, 'stream(s)');
        
        if (event.streams && event.streams[0]) {
          const remoteStream = event.streams[0];
          
          // Vérifier qu'on a bien des pistes
          const videoTracks = remoteStream.getVideoTracks();
          const audioTracks = remoteStream.getAudioTracks();
          
          console.log(`📹 Pistes vidéo: ${videoTracks.length}`);
          console.log(`🔊 Pistes audio: ${audioTracks.length}`);
          
          if (remoteVideoRef.current) {
            remoteVideoRef.current.srcObject = remoteStream;
            remoteVideoRef.current.onloadedmetadata = () => {
              console.log('✅ Métadonnées vidéo chargées');
              remoteVideoRef.current.play().catch(e => console.error('❌ Erreur play:', e));
            };
            
            // Forcer le play au cas où
            setTimeout(() => {
              if (remoteVideoRef.current) {
                remoteVideoRef.current.play().catch(e => console.error('❌ Erreur play timeout:', e));
              }
            }, 1000);
          }
        }
      };

      peerConnection.current = pc;
      console.log('✅ PeerConnection créée');
      return pc;
    } catch (err) {
      console.error('❌ Erreur création PeerConnection:', err);
      return null;
    }
  };

  // Créer et envoyer une offre
  const createAndSendOffer = async () => {
    console.log('📤 Création offre...');
    
    const pc = peerConnection.current;
    if (!pc) {
      console.error('❌ Pas de PeerConnection');
      return;
    }

    try {
      const offer = await pc.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: true
      });

      console.log('✅ Offre créée, définition locale...');
      await pc.setLocalDescription(offer);

      console.log('📤 Envoi offre via socket...');
      socketRef.current.emit('send-offer', {
        callCode,
        offer: pc.localDescription
      });
    } catch (err) {
      console.error('❌ Erreur création offre:', err);
      setError('Erreur lors de l\'initiation de l\'appel');
    }
  };

  // Traiter une offre reçue
  const handleReceivedOffer = async (offer) => {
    console.log('📥 Traitement offre reçue...');
    
    try {
      const pc = createPeerConnection();
      if (!pc) return;

      console.log('🔧 Définition offre distante...');
      await pc.setRemoteDescription(new RTCSessionDescription(offer));

      console.log('🔧 Création réponse...');
      const answer = await pc.createAnswer();
      
      console.log('🔧 Définition réponse locale...');
      await pc.setLocalDescription(answer);

      console.log('📤 Envoi réponse...');
      socketRef.current.emit('send-answer', {
        callCode,
        answer: pc.localDescription
      });
    } catch (err) {
      console.error('❌ Erreur traitement offre:', err);
      setError('Erreur lors de la connexion à l\'appel');
    }
  };

  // Traiter une réponse reçue
  const handleReceivedAnswer = async (answer) => {
    console.log('📥 Traitement réponse reçue...');
    
    try {
      const pc = peerConnection.current;
      if (!pc) return;

      console.log('🔧 Définition réponse distante...');
      await pc.setRemoteDescription(new RTCSessionDescription(answer));
      console.log('✅ Réponse distante définie');
    } catch (err) {
      console.error('❌ Erreur traitement réponse:', err);
    }
  };

  // Créer un appel
  const handleCreateCall = async () => {
    console.log('📞 Création appel...');
    setCallStatus('creating');
    setError('');
    
    const stream = await initLocalStream();
    if (stream) {
      socketRef.current.emit('create-call');
    }
  };

  // Rejoindre un appel
  const handleJoinCall = async () => {
    const code = inputCallCode.trim().toUpperCase();
    if (code.length !== 6) {
      setError('Le code doit contenir 6 caractères');
      return;
    }

    console.log('🔗 Rejoindre appel:', code);
    setCallStatus('joining');
    setError('');
    
    const stream = await initLocalStream();
    if (stream) {
      socketRef.current.emit('join-call', { callCode: code });
    }
  };

  // Accepter un participant
  const handleAcceptParticipant = () => {
    if (waitingParticipantId && socketRef.current) {
      console.log('✅ Acceptation participant:', waitingParticipantId);
      socketRef.current.emit('accept-participant', {
        callCode,
        participantId: waitingParticipantId
      });
      setShowWaitingModal(false);
      setWaitingParticipantId(null);
    }
  };

  // Refuser un participant
  const handleRejectParticipant = () => {
    if (waitingParticipantId && socketRef.current) {
      console.log('❌ Refus participant:', waitingParticipantId);
      socketRef.current.emit('reject-participant', {
        callCode,
        participantId: waitingParticipantId
      });
      setShowWaitingModal(false);
      setWaitingParticipantId(null);
    }
  };

  // Quitter l'appel
  const handleEndCall = () => {
    console.log('🚪 Fin appel');
    
    if (socketRef.current && callCode) {
      socketRef.current.emit('leave-call', { callCode });
    }
    
    cleanup();
    resetState();
  };

  // Nettoyer
  const cleanup = () => {
    console.log('🧹 Nettoyage...');
    
    if (peerConnection.current) {
      peerConnection.current.close();
      peerConnection.current = null;
    }
    
    if (localStream.current) {
      localStream.current.getTracks().forEach(track => track.stop());
      localStream.current = null;
    }
    
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = null;
    }
    
    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = null;
    }
  };

  // Réinitialiser l'état
  const resetState = () => {
    setCallCode('');
    setInputCallCode('');
    setCallStatus('idle');
    setError('');
    setIsCreator(false);
    setShowWaitingModal(false);
    setWaitingParticipantId(null);
  };

  // Copier le code
  const copyCallCode = () => {
    navigator.clipboard.writeText(callCode);
    alert('Code copié dans le presse-papier !');
  };

  return (
    <div className="App">
      <header className="App-header">
        <h1>🎥 Appel Vidéo</h1>
        <p>Connexion simple avec code secret</p>
        <div className="connection-status">
          {connectionStatus === 'connected' ? '✅ Connecté' : '❌ Déconnecté'}
        </div>
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
              <p>Quelqu'un veut rejoindre votre appel</p>
              <div className="modal-buttons">
                <button className="btn-accept" onClick={handleAcceptParticipant}>
                  ✅ Accepter
                </button>
                <button className="btn-reject" onClick={handleRejectParticipant}>
                  ❌ Refuser
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Écran principal */}
        {callStatus === 'idle' && (
          <div className="home-screen">
            <div className="video-preview">
              <video
                ref={localVideoRef}
                autoPlay
                muted
                playsInline
                className="preview-video"
              />
              <p>Votre caméra</p>
            </div>
            
            <div className="actions">
              <button className="btn-create" onClick={handleCreateCall}>
                📞 Créer un appel
              </button>
              
              <div className="divider">OU</div>
              
              <div className="join-section">
                <input
                  type="text"
                  placeholder="Code à 6 lettres"
                  value={inputCallCode}
                  onChange={(e) => setInputCallCode(e.target.value.toUpperCase())}
                  maxLength={6}
                  className="code-input"
                />
                <button className="btn-join" onClick={handleJoinCall}>
                  🔗 Rejoindre
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Création/rejoindre en cours */}
        {callStatus === 'creating' && (
          <div className="loading">
            <div className="spinner"></div>
            <p>Création de l'appel...</p>
          </div>
        )}

        {callStatus === 'joining' && (
          <div className="loading">
            <div className="spinner"></div>
            <p>Connexion à l'appel...</p>
          </div>
        )}

        {/* En attente de participants */}
        {callStatus === 'waiting' && (
          <div className="waiting-screen">
            <h2>⏳ En attente d'un participant...</h2>
            
            <div className="call-code-section">
              <p>Code d'appel :</p>
              <h1 className="call-code">{callCode}</h1>
              <button className="btn-copy" onClick={copyCallCode}>
                📋 Copier le code
              </button>
            </div>
            
            <div className="local-video">
              <h3>Votre caméra :</h3>
              <video
                ref={localVideoRef}
                autoPlay
                muted
                playsInline
                className="waiting-video"
              />
            </div>
            
            <button className="btn-end" onClick={handleEndCall}>
              Annuler l'appel
            </button>
          </div>
        )}

        {/* En appel */}
        {callStatus === 'in-call' && (
          <div className="call-screen">
            <div className="call-info-bar">
              <span>Code: <strong>{callCode}</strong></span>
              <span>{isCreator ? '👑 Créateur' : '👤 Participant'}</span>
              <span className="webrtc-status">
                {peerConnection.current?.iceConnectionState === 'connected' 
                  ? '✅ Connecté' 
                  : '🔄 Connexion...'}
              </span>
            </div>
            
            <div className="video-container">
              <div className="video-box local-video">
                <h3>Vous</h3>
                <video
                  ref={localVideoRef}
                  autoPlay
                  muted
                  playsInline
                  className="video-feed"
                />
              </div>
              
              <div className="video-box remote-video">
                <h3>Participant</h3>
                <video
                  ref={remoteVideoRef}
                  autoPlay
                  playsInline
                  className="video-feed"
                />
                {!remoteVideoRef.current?.srcObject && (
                  <div className="waiting-message">
                    <div className="spinner small"></div>
                    <p>Connexion en cours...</p>
                  </div>
                )}
              </div>
            </div>
            
            <div className="call-controls">
              <button className="btn-end-call" onClick={handleEndCall}>
                🚪 Quitter l'appel
              </button>
            </div>
          </div>
        )}
      </main>

      <footer className="App-footer">
        <p>Application d'appel vidéo WebRTC • Déployé sur Render + Vercel</p>
        <p className="debug-info">
          Socket ID: {socket?.id?.substring(0, 8)}... | 
          ICE State: {peerConnection.current?.iceConnectionState || 'N/A'}
        </p>
      </footer>
    </div>
  );
}

export default App;
