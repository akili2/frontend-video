import React, { useState, useEffect, useRef } from 'react';
import './App.css';
import io from 'socket.io-client';

const SOCKET_SERVER_URL = process.env.REACT_APP_SOCKET_URL || 'http://localhost:5000';

function App() {
  const [socket, setSocket] = useState(null);
  const [callCode, setCallCode] = useState('');
  const [inputCallCode, setInputCallCode] = useState('');
  const [callStatus, setCallStatus] = useState('idle');
  const [participants, setParticipants] = useState(1); // Commence à 1 (vous-même)
  const [error, setError] = useState('');
  const [isCreator, setIsCreator] = useState(false);
  const [remoteParticipantId, setRemoteParticipantId] = useState(null);

  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const peerConnection = useRef(null);
  const localStream = useRef(null);
  const socketRef = useRef(null);
  const callIdRef = useRef(null);

  const configuration = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun2.l.google.com:19302' },
      { urls: 'stun:stun3.l.google.com:19302' },
      { urls: 'stun:stun4.l.google.com:19302' }
    ]
  };

  useEffect(() => {
    const newSocket = io(SOCKET_SERVER_URL, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 1000
    });
    
    socketRef.current = newSocket;
    setSocket(newSocket);

    newSocket.on('connect', () => {
      console.log('Connecté au serveur Socket.io:', newSocket.id);
    });

    newSocket.on('disconnect', () => {
      console.log('Déconnecté du serveur');
    });

    newSocket.on('call-created', handleCallCreated);
    newSocket.on('call-joined', handleCallJoined);
    newSocket.on('call-not-found', handleCallNotFound);
    newSocket.on('call-full', handleCallFull);
    newSocket.on('participant-joined', handleParticipantJoined);
    newSocket.on('participant-left', handleParticipantLeft);
    newSocket.on('receive-offer', handleReceiveOffer);
    newSocket.on('receive-answer', handleReceiveAnswer);
    newSocket.on('receive-ice-candidate', handleReceiveIceCandidate);

    initMediaDevices();

    return () => {
      if (newSocket) newSocket.disconnect();
      cleanupMediaStreams();
    };
  }, []);

  const initMediaDevices = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
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
      });
      
      localStream.current = stream;
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
        localVideoRef.current.muted = true;
      }
      console.log('Médias initialisés avec succès');
    } catch (err) {
      console.error('Erreur d\'accès aux médias:', err);
      setError('Impossible d\'accéder à la caméra/microphone. Veuillez vérifier vos permissions.');
    }
  };

  const cleanupMediaStreams = () => {
    if (localStream.current) {
      localStream.current.getTracks().forEach(track => {
        track.stop();
        track.enabled = false;
      });
      localStream.current = null;
    }
    
    if (peerConnection.current) {
      peerConnection.current.close();
      peerConnection.current = null;
    }
    
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = null;
    }
    
    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = null;
    }
  };

  const createPeerConnection = () => {
    console.log('Création de la connexion peer-to-peer...');
    
    const pc = new RTCPeerConnection(configuration);
    
    // Ajouter les tracks locaux
    if (localStream.current) {
      localStream.current.getTracks().forEach(track => {
        console.log('Ajout de la track locale:', track.kind);
        pc.addTrack(track, localStream.current);
      });
    }

    // Gestion des candidats ICE
    pc.onicecandidate = (event) => {
      console.log('Nouveau candidat ICE:', event.candidate ? 'trouvé' : 'fini');
      if (event.candidate && callCode && socketRef.current) {
        socketRef.current.emit('send-ice-candidate', {
          callCode,
          candidate: event.candidate
        });
      }
    };

    pc.oniceconnectionstatechange = () => {
      console.log('État de connexion ICE:', pc.iceConnectionState);
      if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
        console.log('Connexion WebRTC établie!');
      }
    };

    pc.ontrack = (event) => {
      console.log('Track distant reçu:', event.track.kind);
      if (event.streams && event.streams[0] && remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = event.streams[0];
        console.log('Flux vidéo distant attaché');
      }
    };

    pc.onnegotiationneeded = async () => {
      console.log('Négociation nécessaire...');
      try {
        if (isCreator && callStatus === 'in-call') {
          await createAndSendOffer();
        }
      } catch (err) {
        console.error('Erreur lors de la négociation:', err);
      }
    };

    peerConnection.current = pc;
    return pc;
  };

  const handleCallCreated = (data) => {
    console.log('Appel créé:', data);
    setCallCode(data.callCode);
    setIsCreator(true);
    setCallStatus('waiting');
    setParticipants(1);
    setError('');
    callIdRef.current = data.callId;
  };

  const handleCallJoined = (data) => {
    console.log('Appel rejoint:', data);
    setCallCode(inputCallCode.toUpperCase());
    setIsCreator(false);
    setCallStatus('joined');
    setParticipants(data.participantCount || 2);
    setError('');
    callIdRef.current = data.callId;
    
    // Si on rejoint un appel avec déjà un participant
    if (data.participantCount === 2) {
      setCallStatus('in-call');
      // Créer la connexion peer-to-peer immédiatement
      setTimeout(() => {
        createPeerConnection();
      }, 1000);
    }
  };

  const handleCallNotFound = () => {
    console.log('Appel non trouvé');
    setError('❌ Code d\'appel introuvable. Vérifiez le code et réessayez.');
    setCallStatus('idle');
    setParticipants(1);
  };

  const handleCallFull = () => {
    console.log('Appel complet');
    setError('❌ L\'appel est complet (maximum 2 participants)');
    setCallStatus('idle');
    setParticipants(1);
  };

  const handleParticipantJoined = (data) => {
    console.log('Nouveau participant:', data);
    setParticipants(data.participantCount || 2);
    setRemoteParticipantId(data.participantId);
    
    if (isCreator) {
      setCallStatus('in-call');
      // Créer et envoyer l'offre au nouveau participant
      setTimeout(() => {
        createAndSendOffer();
      }, 1000);
    }
  };

  const handleParticipantLeft = (data) => {
    console.log('Participant parti:', data);
    setParticipants(prev => Math.max(1, prev - 1));
    setRemoteParticipantId(null);
    
    if (isCreator) {
      setCallStatus('waiting');
      setError('Le participant a quitté l\'appel. En attente d\'un nouveau participant...');
    } else {
      setError('L\'autre participant a quitté l\'appel.');
      setTimeout(() => {
        endCall();
      }, 3000);
    }
    
    // Nettoyer la connexion WebRTC
    if (peerConnection.current) {
      peerConnection.current.close();
      peerConnection.current = null;
    }
    
    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = null;
    }
  };

  const handleReceiveOffer = async (data) => {
    console.log('Offre reçue:', data);
    setCallStatus('in-call');
    setParticipants(2);
    
    try {
      const pc = createPeerConnection();
      
      await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
      console.log('Description distante définie');
      
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      console.log('Réponse créée et définie localement');
      
      socketRef.current.emit('send-answer', {
        callCode,
        answer
      });
    } catch (err) {
      console.error('Erreur lors du traitement de l\'offre:', err);
      setError('Erreur lors de l\'établissement de la connexion');
    }
  };

  const handleReceiveAnswer = async (data) => {
    console.log('Réponse reçue:', data);
    if (peerConnection.current && peerConnection.current.signalingState !== 'stable') {
      try {
        await peerConnection.current.setRemoteDescription(
          new RTCSessionDescription(data.answer)
        );
        console.log('Réponse distante définie avec succès');
      } catch (err) {
        console.error('Erreur lors de la définition de la réponse:', err);
      }
    }
  };

  const handleReceiveIceCandidate = async (data) => {
    console.log('Candidat ICE reçu:', data);
    if (peerConnection.current && data.candidate) {
      try {
        await peerConnection.current.addIceCandidate(
          new RTCIceCandidate(data.candidate)
        );
        console.log('Candidat ICE ajouté avec succès');
      } catch (err) {
        console.error('Erreur d\'ajout du candidat ICE:', err);
      }
    }
  };

  const createAndSendOffer = async () => {
    console.log('Création de l\'offre...');
    if (!peerConnection.current) {
      createPeerConnection();
    }
    
    try {
      const offer = await peerConnection.current.createOffer({
        offerToReceiveAudio: true,
        offerToReceiveVideo: true
      });
      
      await peerConnection.current.setLocalDescription(offer);
      console.log('Offre créée et définie localement');
      
      socketRef.current.emit('send-offer', {
        callCode,
        offer
      });
    } catch (err) {
      console.error('Erreur lors de la création de l\'offre:', err);
      setError('Erreur lors de l\'initiation de l\'appel');
    }
  };

  const createCall = () => {
    console.log('Création d\'un appel...');
    if (socketRef.current) {
      setCallStatus('creating');
      setError('');
      socketRef.current.emit('create-call');
    }
  };

  const joinCall = () => {
    const code = inputCallCode.trim().toUpperCase();
    if (code.length === 6) {
      console.log('Tentative de rejoindre l\'appel:', code);
      setCallStatus('joining');
      setError('');
      socketRef.current.emit('join-call', { callCode: code });
    } else {
      setError('Le code doit contenir exactement 6 caractères');
    }
  };

  const endCall = () => {
    console.log('Fin de l\'appel');
    
    if (socketRef.current && callCode) {
      socketRef.current.emit('leave-call', { callCode });
    }
    
    cleanupMediaStreams();
    
    setCallStatus('idle');
    setCallCode('');
    setInputCallCode('');
    setParticipants(1);
    setIsCreator(false);
    setRemoteParticipantId(null);
    setError('');
    callIdRef.current = null;
  };

  return (
    <div className="App">
      <header className="App-header">
        <h1>🎥 Appel Vidéo Simple</h1>
        <p>Créez ou rejoignez un appel avec un code à 6 caractères</p>
      </header>

      <main className="App-main">
        {error && (
          <div className={`message ${error.includes('❌') ? 'error' : 'info'}`}>
            {error}
          </div>
        )}

        {callStatus === 'idle' && (
          <div className="call-actions">
            <div className="action-card">
              <h2>📞 Créer un appel</h2>
              <p>Générez un code unique et partagez-le</p>
              <button className="btn-create" onClick={createCall}>
                Créer un nouvel appel
              </button>
            </div>
            
            <div className="divider">
              <span>OU</span>
            </div>
            
            <div className="action-card">
              <h2>🔗 Rejoindre un appel</h2>
              <p>Entrez le code fourni par votre contact</p>
              <div className="join-input-group">
                <input
                  type="text"
                  placeholder="EX: ABC123"
                  value={inputCallCode}
                  onChange={(e) => setInputCallCode(e.target.value.toUpperCase())}
                  maxLength="6"
                  pattern="[A-Z0-9]{6}"
                  className="join-input"
                />
                <button className="btn-join" onClick={joinCall}>
                  Rejoindre
                </button>
              </div>
            </div>
          </div>
        )}

        {callStatus === 'creating' && (
          <div className="loading">
            <div className="spinner"></div>
            <p>Création de votre appel en cours...</p>
          </div>
        )}

        {callStatus === 'joining' && (
          <div className="loading">
            <div className="spinner"></div>
            <p>Connexion à l'appel...</p>
          </div>
        )}

        {callStatus === 'waiting' && (
          <div className="waiting-room">
            <h2>⏳ En attente d'un participant...</h2>
            <div className="call-code-display">
              <p>Code d'appel :</p>
              <h1>{callCode}</h1>
              <p className="instruction">
                Partagez ce code avec la personne que vous voulez appeler
              </p>
              <div className="share-buttons">
                <button 
                  onClick={() => navigator.clipboard.writeText(callCode)}
                  className="btn-copy"
                >
                  📋 Copier le code
                </button>
              </div>
            </div>
            <div className="participant-info">
              <div className="participant-count">
                <span className="count">{participants}</span>/2 participants connectés
              </div>
            </div>
            <button className="btn-end" onClick={endCall}>
              Annuler l'appel
            </button>
          </div>
        )}

        {(callStatus === 'joined' || callStatus === 'in-call') && (
          <div className="video-container">
            <div className="call-header">
              <h2>
                {isCreator ? '👑 Vous avez créé cet appel' : '👤 Vous avez rejoint cet appel'}
              </h2>
              <div className="call-meta">
                <div className="meta-item">
                  <span className="meta-label">Code :</span>
                  <span className="meta-value">{callCode}</span>
                </div>
                <div className="meta-item">
                  <span className="meta-label">Participants :</span>
                  <span className="meta-value">{participants}/2</span>
                </div>
                <div className="meta-item">
                  <span className="meta-label">Statut :</span>
                  <span className="meta-value status">
                    {callStatus === 'in-call' ? '✅ Connecté' : '⏳ En attente...'}
                  </span>
                </div>
              </div>
            </div>
            
            <div className="video-grid">
              <div className="video-wrapper local">
                <div className="video-header">
                  <h3>Vous {isCreator && '(Créateur)'}</h3>
                  <div className="video-status">
                    {localStream.current ? '✅ Caméra active' : '❌ Caméra inactive'}
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
                  <h3>Participant {remoteParticipantId ? 'connecté' : 'distant'}</h3>
                  <div className="video-status">
                    {remoteVideoRef.current?.srcObject ? 
                      '✅ Vidéo reçue' : 
                      callStatus === 'in-call' ? '🔄 Connexion en cours...' : '⏳ En attente'}
                  </div>
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
                    <p>En attente de la vidéo du participant...</p>
                    <p className="hint">
                      {isCreator ? 
                        'Le participant doit entrer votre code pour se connecter' :
                        'Le créateur doit accepter la connexion'}
                    </p>
                  </div>
                )}
              </div>
            </div>
            
            <div className="call-controls">
              <button className="btn-end" onClick={endCall}>
                🚪 Quitter l'appel
              </button>
              
              <div className="control-buttons">
                <button 
                  className="btn-control"
                  onClick={() => {
                    if (localStream.current) {
                      const videoTrack = localStream.current.getVideoTracks()[0];
                      if (videoTrack) {
                        videoTrack.enabled = !videoTrack.enabled;
                      }
                    }
                  }}
                >
                  📹 Caméra
                </button>
                
                <button 
                  className="btn-control"
                  onClick={() => {
                    if (localStream.current) {
                      const audioTrack = localStream.current.getAudioTracks()[0];
                      if (audioTrack) {
                        audioTrack.enabled = !audioTrack.enabled;
                      }
                    }
                  }}
                >
                  🎤 Microphone
                </button>
              </div>
            </div>
          </div>
        )}
      </main>

      <footer className="App-footer">
        <p>Application d'appel vidéo WebRTC • Déployé sur Render + Vercel</p>
        <p className="socket-status">
          {socket?.connected ? '✅ Connecté au serveur' : '❌ Déconnecté du serveur'}
        </p>
      </footer>
    </div>
  );
}

export default App;
