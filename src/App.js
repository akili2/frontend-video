import React, { useState, useEffect, useRef } from 'react';
import './App.css';
import io from 'socket.io-client';

const SOCKET_SERVER_URL = process.env.REACT_APP_SOCKET_URL || 'http://localhost:5000';

function App() {
  const [socket, setSocket] = useState(null);
  const [callCode, setCallCode] = useState('');
  const [inputCallCode, setInputCallCode] = useState('');
  const [callStatus, setCallStatus] = useState('idle');
  const [participants, setParticipants] = useState(1);
  const [error, setError] = useState('');
  const [isCreator, setIsCreator] = useState(false);
  const [remoteParticipantId, setRemoteParticipantId] = useState(null);
  const [waitingParticipants, setWaitingParticipants] = useState([]);
  const [showWaitingModal, setShowWaitingModal] = useState(false);

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
      { urls: 'stun:stun2.l.google.com:19302' }
    ]
  };

  useEffect(() => {
    const newSocket = io(SOCKET_SERVER_URL, {
      transports: ['websocket', 'polling'],
      reconnection: true
    });
    
    socketRef.current = newSocket;
    setSocket(newSocket);

    // Événements Socket.io
    newSocket.on('connect', () => {
      console.log('Connecté:', newSocket.id);
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

    initMediaDevices();

    return () => {
      if (newSocket) newSocket.disconnect();
      cleanupMediaStreams();
    };
  }, []);

  // Initialiser la caméra/microphone
  const initMediaDevices = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480 },
        audio: true
      });
      
      localStream.current = stream;
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = stream;
      }
    } catch (err) {
      console.error('Erreur caméra:', err);
      setError('Veuillez autoriser la caméra et le microphone');
    }
  };

  // Gestionnaires d'événements
  const handleCallCreated = (data) => {
    setCallCode(data.callCode);
    setIsCreator(true);
    setCallStatus('waiting');
    setParticipants(1);
    setError('');
    callIdRef.current = data.callId;
  };

  const handleCallJoined = (data) => {
    setCallCode(inputCallCode.toUpperCase());
    setIsCreator(false);
    setCallStatus('in-call');
    setParticipants(data.participantCount || 2);
    setError('');
    callIdRef.current = data.callId;
    
    // Créer la connexion peer-to-peer
    setTimeout(() => {
      createPeerConnection();
    }, 500);
  };

  const handleCallWaiting = (data) => {
    setCallCode(inputCallCode.toUpperCase());
    setIsCreator(false);
    setCallStatus('waiting-approval');
    setError('⏳ En attente de l\'approbation du créateur...');
  };

  const handleCallRejected = () => {
    setError('❌ Le créateur a refusé votre demande de connexion');
    setCallStatus('idle');
    setParticipants(1);
  };

  const handleCallBusy = () => {
    setError('⏳ Un participant est déjà en attente sur cet appel');
    setCallStatus('idle');
  };

  const handleParticipantWaiting = (data) => {
    setWaitingParticipants(prev => [...prev, data.participantId]);
    setShowWaitingModal(true);
  };

  const handleParticipantAccepted = (data) => {
    setParticipants(data.participantCount);
    setRemoteParticipantId(data.participantId);
    setCallStatus('in-call');
    
    // Si c'est le créateur, envoyer l'offre WebRTC
    if (isCreator) {
      setTimeout(() => {
        createAndSendOffer();
      }, 1000);
    }
  };

  const handleParticipantRejected = (data) => {
    setWaitingParticipants(prev => prev.filter(id => id !== data.participantId));
    if (waitingParticipants.length <= 1) {
      setShowWaitingModal(false);
    }
  };

  const handleParticipantLeft = (data) => {
    setParticipants(data.participantCount);
    setRemoteParticipantId(null);
    
    if (isCreator) {
      setCallStatus('waiting');
      setError('Le participant a quitté l\'appel');
    } else {
      setError('L\'autre participant a quitté l\'appel');
      setTimeout(() => endCall(), 3000);
    }
    
    // Nettoyer WebRTC
    if (peerConnection.current) {
      peerConnection.current.close();
      peerConnection.current = null;
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

  // Fonctions pour accepter/refuser
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

  // Créer la connexion WebRTC
  const createPeerConnection = () => {
    const pc = new RTCPeerConnection(configuration);
    
    // Ajouter le flux local
    if (localStream.current) {
      localStream.current.getTracks().forEach(track => {
        pc.addTrack(track, localStream.current);
      });
    }

    // Gestion des candidats ICE
    pc.onicecandidate = (event) => {
      if (event.candidate && callCode && socketRef.current) {
        socketRef.current.emit('send-ice-candidate', {
          callCode,
          candidate: event.candidate
        });
      }
    };

    // Réception du flux distant
    pc.ontrack = (event) => {
      if (event.streams[0] && remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = event.streams[0];
      }
    };

    peerConnection.current = pc;
    return pc;
  };

  // Créer et envoyer une offre WebRTC
  const createAndSendOffer = async () => {
    if (!peerConnection.current) {
      createPeerConnection();
    }
    
    try {
      const offer = await peerConnection.current.createOffer();
      await peerConnection.current.setLocalDescription(offer);
      
      socketRef.current.emit('send-offer', {
        callCode,
        offer
      });
    } catch (err) {
      console.error('Erreur offre:', err);
      setError('Erreur lors de l\'initiation de l\'appel');
    }
  };

  // Gérer l'offre reçue
  const handleReceiveOffer = async (data) => {
    setCallStatus('in-call');
    setParticipants(2);
    
    try {
      const pc = createPeerConnection();
      await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
      
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      
      socketRef.current.emit('send-answer', {
        callCode,
        answer
      });
    } catch (err) {
      console.error('Erreur traitement offre:', err);
    }
  };

  // Gérer la réponse reçue
  const handleReceiveAnswer = async (data) => {
    if (peerConnection.current) {
      try {
        await peerConnection.current.setRemoteDescription(
          new RTCSessionDescription(data.answer)
        );
      } catch (err) {
        console.error('Erreur réponse:', err);
      }
    }
  };

  // Gérer les candidats ICE
  const handleReceiveIceCandidate = async (data) => {
    if (peerConnection.current && data.candidate) {
      try {
        await peerConnection.current.addIceCandidate(
          new RTCIceCandidate(data.candidate)
        );
      } catch (err) {
        console.error('Erreur ICE:', err);
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
    if (socketRef.current && callCode) {
      socketRef.current.emit('leave-call', { callCode });
    }
    
    if (peerConnection.current) {
      peerConnection.current.close();
      peerConnection.current = null;
    }
    
    if (localStream.current) {
      localStream.current.getTracks().forEach(track => track.stop());
    }
    
    setCallStatus('idle');
    setCallCode('');
    setInputCallCode('');
    setParticipants(1);
    setIsCreator(false);
    setRemoteParticipantId(null);
    setError('');
    setWaitingParticipants([]);
    setShowWaitingModal(false);
  };

  // Nettoyer
  const cleanupMediaStreams = () => {
    if (localStream.current) {
      localStream.current.getTracks().forEach(track => track.stop());
    }
    if (peerConnection.current) {
      peerConnection.current.close();
    }
  };

  return (
    <div className="App">
      <header className="App-header">
        <h1>🎥 Appel Vidéo avec Approbation</h1>
        <p>Le créateur doit accepter les demandes de connexion</p>
      </header>

      <main className="App-main">
        {error && (
          <div className={`message ${error.includes('❌') ? 'error' : 'info'}`}>
            {error}
          </div>
        )}

        {/* Modal d'attente pour le créateur */}
        {showWaitingModal && waitingParticipants.length > 0 && (
          <div className="modal-overlay">
            <div className="modal">
              <h3>🔔 Demande de connexion</h3>
              <p>Un participant souhaite rejoindre votre appel</p>
              
              {waitingParticipants.map(participantId => (
                <div key={participantId} className="waiting-participant">
                  <p>Participant: <strong>{participantId.substring(0, 8)}...</strong></p>
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
            <button className="btn-create" onClick={createCall}>
              Créer un nouvel appel
            </button>
            
            <div className="join-section">
              <h3>Rejoindre un appel</h3>
              <input
                type="text"
                placeholder="Entrez le code (6 caractères)"
                value={inputCallCode}
                onChange={(e) => setInputCallCode(e.target.value.toUpperCase())}
                maxLength="6"
              />
              <button className="btn-join" onClick={joinCall}>
                Rejoindre
              </button>
            </div>
          </div>
        )}

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

        {callStatus === 'waiting-approval' && (
          <div className="waiting-approval">
            <div className="spinner"></div>
            <h2>⏳ En attente d'approbation</h2>
            <p>Le créateur doit accepter votre demande de connexion</p>
            <p className="call-code">Code: <strong>{callCode}</strong></p>
            <button className="btn-end" onClick={endCall}>
              Annuler
            </button>
          </div>
        )}

        {callStatus === 'waiting' && isCreator && (
          <div className="waiting-room">
            <h2>⏳ En attente d'un participant...</h2>
            <div className="call-code-display">
              <p>Code d'appel :</p>
              <h1>{callCode}</h1>
              <p>Partagez ce code avec la personne que vous voulez appeler</p>
              <button 
                className="btn-copy"
                onClick={() => navigator.clipboard.writeText(callCode)}
              >
                📋 Copier le code
              </button>
            </div>
            
            {waitingParticipants.length > 0 ? (
              <div className="waiting-notification">
                <p>🔔 {waitingParticipants.length} participant(s) en attente</p>
                <button 
                  className="btn-view-requests"
                  onClick={() => setShowWaitingModal(true)}
                >
                  Voir les demandes
                </button>
              </div>
            ) : (
              <p className="no-waiting">Aucune demande en attente</p>
            )}
            
            <div className="participant-info">
              <div className="participant-count">
                <span className="count">{participants}</span>/2 participants
              </div>
            </div>
            
            <button className="btn-end" onClick={endCall}>
              Annuler l'appel
            </button>
          </div>
        )}

        {callStatus === 'in-call' && (
          <div className="video-container">
            <div className="video-grid">
              <div className="video-wrapper">
                <h3>Vous {isCreator && '(Créateur)'}</h3>
                <video
                  ref={localVideoRef}
                  autoPlay
                  muted
                  playsInline
                  className="video-element"
                />
              </div>
              
              <div className="video-wrapper">
                <h3>Participant</h3>
                <video
                  ref={remoteVideoRef}
                  autoPlay
                  playsInline
                  className="video-element"
                />
                {!remoteVideoRef.current?.srcObject && (
                  <div className="waiting-video">
                    <p>Connexion en cours...</p>
                  </div>
                )}
              </div>
            </div>
            
            <div className="call-info">
              <p>Code: <strong>{callCode}</strong></p>
              <p>Participants: <strong>{participants}/2</strong></p>
              <p>Statut: <strong className="status-connected">✅ Connecté</strong></p>
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
        <p>Appel Vidéo • Le créateur contrôle les connexions</p>
        <p className="socket-status">
          {socket?.connected ? '✅ Connecté au serveur' : '❌ Déconnecté'}
        </p>
      </footer>
    </div>
  );
}

export default App;
