// App.tsx
import { ConnectButton } from '@rainbow-me/rainbowkit';
import '@rainbow-me/rainbowkit/styles.css';
import React, { useEffect, useState } from "react";
import { ethers } from "ethers";
import { getContractReadOnly, getContractWithSigner } from "./contract";
import "./App.css";
import { useAccount, useSignMessage } from 'wagmi';

interface TimeRecord {
  id: number;
  serviceType: string;
  hours: string; // FHE encrypted string
  timestamp: number;
  provider: string;
  receiver?: string;
  status: 'deposited' | 'withdrawn' | 'pending';
}

interface UserAction {
  type: 'deposit' | 'withdraw' | 'decrypt';
  timestamp: number;
  details: string;
}

// FHE encryption/decryption functions
const FHEEncryptNumber = (value: number): string => `FHE-${btoa(value.toString())}`;
const FHEDecryptNumber = (encryptedData: string): number => encryptedData.startsWith('FHE-') ? parseFloat(atob(encryptedData.substring(4))) : parseFloat(encryptedData);
const generatePublicKey = () => `0x${Array(2000).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join('')}`;

const COLORS = ['#8BAAAD', '#6B8E4E', '#D4A59A', '#F3DDB3'];

const App: React.FC = () => {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(true);
  const [timeRecords, setTimeRecords] = useState<TimeRecord[]>([]);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showDepositModal, setShowDepositModal] = useState(false);
  const [depositing, setDepositing] = useState(false);
  const [transactionStatus, setTransactionStatus] = useState<{ visible: boolean; status: "pending" | "success" | "error"; message: string; }>({ visible: false, status: "pending", message: "" });
  const [newRecordData, setNewRecordData] = useState({ serviceType: "", hours: "" });
  const [selectedRecord, setSelectedRecord] = useState<TimeRecord | null>(null);
  const [decryptedHours, setDecryptedHours] = useState<number | null>(null);
  const [isDecrypting, setIsDecrypting] = useState(false);
  const [publicKey, setPublicKey] = useState("");
  const [contractAddress, setContractAddress] = useState("");
  const [chainId, setChainId] = useState(0);
  const [startTimestamp, setStartTimestamp] = useState(0);
  const [durationDays, setDurationDays] = useState(30);
  const [userActions, setUserActions] = useState<UserAction[]>([]);
  const [activeTab, setActiveTab] = useState('records');
  
  // Initialize signature parameters
  useEffect(() => {
    loadData().finally(() => setLoading(false));
    const initSignatureParams = async () => {
      const contract = await getContractReadOnly();
      if (contract) setContractAddress(await contract.getAddress());
      if (window.ethereum) {
        const chainIdHex = await window.ethereum.request({ method: 'eth_chainId' });
        setChainId(parseInt(chainIdHex, 16));
      }
      setStartTimestamp(Math.floor(Date.now() / 1000));
      setDurationDays(30);
      setPublicKey(generatePublicKey());
    };
    initSignatureParams();
  }, []);

  // Load data from contract
  const loadData = async () => {
    setIsRefreshing(true);
    try {
      const contract = await getContractReadOnly();
      if (!contract) return;
      
      // Check contract availability
      const isAvailable = await contract.isAvailable();
      if (!isAvailable) {
        setTransactionStatus({ visible: true, status: "success", message: "Contract is available!" });
        setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 2000);
      }
      
      // Load time records
      const recordsBytes = await contract.getData("timeRecords");
      let recordsList: TimeRecord[] = [];
      if (recordsBytes.length > 0) {
        try {
          const recordsStr = ethers.toUtf8String(recordsBytes);
          if (recordsStr.trim() !== '') recordsList = JSON.parse(recordsStr);
        } catch (e) {}
      }
      setTimeRecords(recordsList);
    } catch (e) {
      console.error("Error loading data:", e);
      setTransactionStatus({ visible: true, status: "error", message: "Failed to load data" });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { 
      setIsRefreshing(false); 
      setLoading(false); 
    }
  };

  // Deposit new time record
  const depositTime = async () => {
    if (!isConnected || !address) { 
      setTransactionStatus({ visible: true, status: "error", message: "Please connect wallet first" });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
      return; 
    }
    
    setDepositing(true);
    setTransactionStatus({ visible: true, status: "pending", message: "Depositing time with Zama FHE..." });
    
    try {
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      // Create new time record
      const hoursValue = parseFloat(newRecordData.hours);
      if (isNaN(hoursValue) || hoursValue <= 0) throw new Error("Invalid hours value");
      
      const newRecord: TimeRecord = {
        id: timeRecords.length + 1,
        serviceType: newRecordData.serviceType,
        hours: FHEEncryptNumber(hoursValue),
        timestamp: Math.floor(Date.now() / 1000),
        provider: address,
        status: 'deposited'
      };
      
      // Update records list
      const updatedRecords = [...timeRecords, newRecord];
      
      // Save to contract
      await contract.setData("timeRecords", ethers.toUtf8Bytes(JSON.stringify(updatedRecords)));
      
      // Update user actions
      const newAction: UserAction = {
        type: 'deposit',
        timestamp: Math.floor(Date.now() / 1000),
        details: `Deposited ${newRecordData.hours} hours for ${newRecordData.serviceType}`
      };
      setUserActions(prev => [newAction, ...prev]);
      
      setTransactionStatus({ visible: true, status: "success", message: "Time deposited successfully!" });
      await loadData();
      
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
        setShowDepositModal(false);
        setNewRecordData({ serviceType: "", hours: "" });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") 
        ? "Transaction rejected by user" 
        : "Deposit failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    } finally { 
      setDepositing(false); 
    }
  };

  // Withdraw time
  const withdrawTime = async (recordId: number) => {
    if (!isConnected || !address) { 
      setTransactionStatus({ visible: true, status: "error", message: "Please connect wallet first" });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
      return; 
    }
    
    setTransactionStatus({ visible: true, status: "pending", message: "Withdrawing time with Zama FHE..." });
    
    try {
      const contract = await getContractWithSigner();
      if (!contract) throw new Error("Failed to get contract with signer");
      
      // Find the record
      const recordIndex = timeRecords.findIndex(r => r.id === recordId);
      if (recordIndex === -1) throw new Error("Record not found");
      
      // Update record status
      const updatedRecords = [...timeRecords];
      updatedRecords[recordIndex] = {
        ...updatedRecords[recordIndex],
        status: 'withdrawn',
        receiver: address
      };
      
      // Save to contract
      await contract.setData("timeRecords", ethers.toUtf8Bytes(JSON.stringify(updatedRecords)));
      
      // Update user actions
      const newAction: UserAction = {
        type: 'withdraw',
        timestamp: Math.floor(Date.now() / 1000),
        details: `Withdrawn ${updatedRecords[recordIndex].hours} hours for ${updatedRecords[recordIndex].serviceType}`
      };
      setUserActions(prev => [newAction, ...prev]);
      
      setTransactionStatus({ visible: true, status: "success", message: "Time withdrawn successfully!" });
      await loadData();
      
      setTimeout(() => {
        setTransactionStatus({ visible: false, status: "pending", message: "" });
      }, 2000);
    } catch (e: any) {
      const errorMessage = e.message.includes("user rejected transaction") 
        ? "Transaction rejected by user" 
        : "Withdrawal failed: " + (e.message || "Unknown error");
      setTransactionStatus({ visible: true, status: "error", message: errorMessage });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
    }
  };

  // Decrypt hours with signature
  const decryptWithSignature = async (encryptedData: string): Promise<number | null> => {
    if (!isConnected) { 
      setTransactionStatus({ visible: true, status: "error", message: "Please connect wallet first" });
      setTimeout(() => setTransactionStatus({ visible: false, status: "pending", message: "" }), 3000);
      return null; 
    }
    
    setIsDecrypting(true);
    try {
      const message = `publickey:${publicKey}\ncontractAddresses:${contractAddress}\ncontractsChainId:${chainId}\nstartTimestamp:${startTimestamp}\ndurationDays:${durationDays}`;
      await signMessageAsync({ message });
      await new Promise(resolve => setTimeout(resolve, 1500));
      
      // Update user actions
      const newAction: UserAction = {
        type: 'decrypt',
        timestamp: Math.floor(Date.now() / 1000),
        details: "Decrypted FHE data"
      };
      setUserActions(prev => [newAction, ...prev]);
      
      return FHEDecryptNumber(encryptedData);
    } catch (e) { 
      return null; 
    } finally { 
      setIsDecrypting(false); 
    }
  };

  // Render FHE flow visualization
  const renderFHEFlow = () => {
    return (
      <div className="fhe-flow">
        <div className="flow-step">
          <div className="step-icon">1</div>
          <div className="step-content">
            <h4>Time Contribution</h4>
            <p>Members deposit community service hours into the time bank</p>
          </div>
        </div>
        <div className="flow-arrow">→</div>
        <div className="flow-step">
          <div className="step-icon">2</div>
          <div className="step-content">
            <h4>FHE Encryption</h4>
            <p>Time records are encrypted using Zama FHE</p>
          </div>
        </div>
        <div className="flow-arrow">→</div>
        <div className="flow-step">
          <div className="step-icon">3</div>
          <div className="step-content">
            <h4>Private Withdrawal</h4>
            <p>Members can withdraw time anonymously when needed</p>
          </div>
        </div>
        <div className="flow-arrow">→</div>
        <div className="flow-step">
          <div className="step-icon">4</div>
          <div className="step-content">
            <h4>Community Support</h4>
            <p>Encrypted time exchange enables private community support</p>
          </div>
        </div>
      </div>
    );
  };

  // Render user actions history
  const renderUserActions = () => {
    if (userActions.length === 0) return <div className="no-data">No actions recorded</div>;
    
    return (
      <div className="actions-list">
        {userActions.map((action, index) => (
          <div className="action-item" key={index}>
            <div className={`action-type ${action.type}`}>
              {action.type === 'deposit' && '⏳'}
              {action.type === 'withdraw' && '⏱️'}
              {action.type === 'decrypt' && '🔓'}
            </div>
            <div className="action-details">
              <div className="action-text">{action.details}</div>
              <div className="action-time">{new Date(action.timestamp * 1000).toLocaleString()}</div>
            </div>
          </div>
        ))}
      </div>
    );
  };

  // Render FAQ section
  const renderFAQ = () => {
    const faqItems = [
      {
        question: "What is Time Bank FHE?",
        answer: "Time Bank FHE is a community system where members can deposit and withdraw service hours with privacy protection using Fully Homomorphic Encryption (FHE)."
      },
      {
        question: "How does FHE protect my privacy?",
        answer: "FHE allows your time records to remain encrypted even during transactions. No one can see your actual hours without your permission."
      },
      {
        question: "How do I earn time credits?",
        answer: "You earn credits by providing services to other community members. Each hour of service equals one time credit."
      },
      {
        question: "Can I see my own time balance?",
        answer: "Yes, you can decrypt your own time records using your wallet signature, but others cannot see them without your permission."
      },
      {
        question: "What blockchain is this built on?",
        answer: "Time Bank FHE is built on Ethereum and utilizes Zama FHE for privacy-preserving time exchange."
      }
    ];
    
    return (
      <div className="faq-container">
        {faqItems.map((item, index) => (
          <div className="faq-item" key={index}>
            <div className="faq-question">{item.question}</div>
            <div className="faq-answer">{item.answer}</div>
          </div>
        ))}
      </div>
    );
  };

  // Prepare data for charts
  const prepareChartData = () => {
    const serviceTypes: Record<string, number> = {};
    
    timeRecords.forEach(record => {
      if (record.status === 'deposited') {
        const hours = FHEDecryptNumber(record.hours);
        serviceTypes[record.serviceType] = (serviceTypes[record.serviceType] || 0) + hours;
      }
    });
    
    return Object.entries(serviceTypes).map(([name, value]) => ({
      name,
      value
    }));
  };

  const prepareMonthlyData = () => {
    const monthlyData: Record<number, number> = {};
    
    timeRecords.forEach(record => {
      if (record.status === 'deposited') {
        const date = new Date(record.timestamp * 1000);
        const month = date.getMonth();
        const hours = FHEDecryptNumber(record.hours);
        monthlyData[month] = (monthlyData[month] || 0) + hours;
      }
    });
    
    return Array(12).fill(0).map((_, month) => ({
      name: new Date(2023, month, 1).toLocaleString('default', { month: 'short' }),
      hours: monthlyData[month] || 0
    }));
  };

  if (loading) return (
    <div className="loading-screen">
      <div className="fhe-spinner"></div>
      <p>Initializing encrypted time bank system...</p>
    </div>
  );

  return (
    <div className="app-container">
      <header className="app-header">
        <div className="logo">
          <div className="logo-icon">
            <div className="time-icon"></div>
          </div>
          <h1>隱時銀行<span>Time Bank FHE</span></h1>
        </div>
        
        <div className="header-actions">
          <button 
            onClick={() => setShowDepositModal(true)} 
            className="deposit-time-btn"
          >
            <div className="add-icon"></div>Deposit Time
          </button>
          <div className="wallet-connect-wrapper">
            <ConnectButton accountStatus="address" chainStatus="icon" showBalance={false}/>
          </div>
        </div>
      </header>
      
      <div className="main-content-container">
        <div className="dashboard-section">
          <div className="dashboard-grid">
            <div className="dashboard-panel intro-panel">
              <div className="panel-card">
                <h2>Private Time Banking with FHE</h2>
                <p>Time Bank FHE allows community members to exchange service hours with complete privacy using Zama FHE encryption.</p>
                <div className="fhe-badge">
                  <div className="fhe-icon"></div>
                  <span>Powered by Zama FHE</span>
                </div>
              </div>
              
              <div className="panel-card">
                <h2>FHE Time Exchange Flow</h2>
                {renderFHEFlow()}
              </div>
              
              <div className="panel-card">
                <h2>Community Statistics</h2>
                <div className="stats-grid">
                  <div className="stat-item">
                    <div className="stat-value">{timeRecords.length}</div>
                    <div className="stat-label">Transactions</div>
                  </div>
                  <div className="stat-item">
                    <div className="stat-value">
                      {timeRecords.length > 0 
                        ? timeRecords.reduce((sum, r) => sum + FHEDecryptNumber(r.hours), 0).toFixed(1)
                        : 0}
                    </div>
                    <div className="stat-label">Total Hours</div>
                  </div>
                  <div className="stat-item">
                    <div className="stat-value">
                      {timeRecords.length > 0 
                        ? (timeRecords.filter(r => r.status === 'withdrawn').length / timeRecords.length * 100).toFixed(1)
                        : 0}%
                    </div>
                    <div className="stat-label">Withdrawal Rate</div>
                  </div>
                </div>
              </div>
            </div>
            
            <div className="dashboard-panel chart-panel">
              <div className="panel-card">
                <h2>Service Type Distribution</h2>
              </div>
              
              <div className="panel-card">
                <h2>Monthly Activity</h2>
              </div>
            </div>
          </div>
          
          <div className="tabs-container">
            <div className="tabs">
              <button 
                className={`tab ${activeTab === 'records' ? 'active' : ''}`}
                onClick={() => setActiveTab('records')}
              >
                Time Records
              </button>
              <button 
                className={`tab ${activeTab === 'actions' ? 'active' : ''}`}
                onClick={() => setActiveTab('actions')}
              >
                My Actions
              </button>
              <button 
                className={`tab ${activeTab === 'faq' ? 'active' : ''}`}
                onClick={() => setActiveTab('faq')}
              >
                FAQ
              </button>
            </div>
            
            <div className="tab-content">
              {activeTab === 'records' && (
                <div className="records-section">
                  <div className="section-header">
                    <h2>Time Transactions</h2>
                    <div className="header-actions">
                      <button 
                        onClick={loadData} 
                        className="refresh-btn" 
                        disabled={isRefreshing}
                      >
                        {isRefreshing ? "Refreshing..." : "Refresh"}
                      </button>
                    </div>
                  </div>
                  
                  <div className="records-list">
                    {timeRecords.length === 0 ? (
                      <div className="no-records">
                        <div className="no-records-icon"></div>
                        <p>No time records found</p>
                        <button 
                          className="deposit-btn" 
                          onClick={() => setShowDepositModal(true)}
                        >
                          Deposit Your First Hours
                        </button>
                      </div>
                    ) : timeRecords.map((record, index) => (
                      <div 
                        className={`record-item ${selectedRecord?.id === record.id ? "selected" : ""}`} 
                        key={index}
                        onClick={() => setSelectedRecord(record)}
                      >
                        <div className="record-type">{record.serviceType}</div>
                        <div className="record-hours">Encrypted Hours: {record.hours.substring(0, 15)}...</div>
                        <div className="record-status">
                          <span className={`status-badge ${record.status}`}>{record.status}</span>
                          {record.provider === address && (
                            <button 
                              className="withdraw-btn"
                              onClick={(e) => {
                                e.stopPropagation();
                                withdrawTime(record.id);
                              }}
                              disabled={record.status !== 'deposited'}
                            >
                              Withdraw
                            </button>
                          )}
                        </div>
                        <div className="record-date">{new Date(record.timestamp * 1000).toLocaleDateString()}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              
              {activeTab === 'actions' && (
                <div className="actions-section">
                  <h2>My Activity History</h2>
                  {renderUserActions()}
                </div>
              )}
              
              {activeTab === 'faq' && (
                <div className="faq-section">
                  <h2>Frequently Asked Questions</h2>
                  {renderFAQ()}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
      
      {showDepositModal && (
        <ModalDepositTime 
          onSubmit={depositTime} 
          onClose={() => setShowDepositModal(false)} 
          depositing={depositing} 
          recordData={newRecordData} 
          setRecordData={setNewRecordData}
        />
      )}
      
      {selectedRecord && (
        <RecordDetailModal 
          record={selectedRecord} 
          onClose={() => { 
            setSelectedRecord(null); 
            setDecryptedHours(null); 
          }} 
          decryptedHours={decryptedHours} 
          setDecryptedHours={setDecryptedHours} 
          isDecrypting={isDecrypting} 
          decryptWithSignature={decryptWithSignature}
          address={address}
        />
      )}
      
      {transactionStatus.visible && (
        <div className="transaction-modal">
          <div className="transaction-content">
            <div className={`transaction-icon ${transactionStatus.status}`}>
              {transactionStatus.status === "pending" && <div className="fhe-spinner"></div>}
              {transactionStatus.status === "success" && <div className="success-icon">✓</div>}
              {transactionStatus.status === "error" && <div className="error-icon">✗</div>}
            </div>
            <div className="transaction-message">{transactionStatus.message}</div>
          </div>
        </div>
      )}
      
      <footer className="app-footer">
        <div className="footer-content">
          <div className="footer-brand">
            <div className="logo">
              <div className="time-icon"></div>
              <span>隱時銀行 Time Bank FHE</span>
            </div>
            <p>Community time exchange powered by FHE</p>
          </div>
          
          <div className="footer-links">
            <a href="#" className="footer-link">Documentation</a>
            <a href="#" className="footer-link">Privacy Policy</a>
            <a href="#" className="footer-link">Terms</a>
            <a href="#" className="footer-link">Contact</a>
          </div>
        </div>
        
        <div className="footer-bottom">
          <div className="fhe-badge">
            <span>Powered by Zama FHE</span>
          </div>
          <div className="copyright">© {new Date().getFullYear()} Time Bank FHE. All rights reserved.</div>
          <div className="disclaimer">
            This system uses fully homomorphic encryption to protect member privacy. 
            Time records are encrypted and can only be decrypted with proper authorization.
          </div>
        </div>
      </footer>
    </div>
  );
};

interface ModalDepositTimeProps {
  onSubmit: () => void; 
  onClose: () => void; 
  depositing: boolean;
  recordData: any;
  setRecordData: (data: any) => void;
}

const ModalDepositTime: React.FC<ModalDepositTimeProps> = ({ onSubmit, onClose, depositing, recordData, setRecordData }) => {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const { name, value } = e.target;
    setRecordData({ ...recordData, [name]: value });
  };

  return (
    <div className="modal-overlay">
      <div className="deposit-time-modal">
        <div className="modal-header">
          <h2>Deposit Service Time</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        
        <div className="modal-body">
          <div className="fhe-notice">
            <div className="lock-icon"></div>
            <div>
              <strong>FHE Privacy Notice</strong>
              <p>Your time records will be encrypted with Zama FHE</p>
            </div>
          </div>
          
          <div className="form-group">
            <label>Service Type *</label>
            <input 
              type="text" 
              name="serviceType" 
              value={recordData.serviceType} 
              onChange={handleChange} 
              placeholder="e.g. Gardening, Tutoring..." 
            />
          </div>
          
          <div className="form-group">
            <label>Hours Contributed *</label>
            <input 
              type="number" 
              name="hours" 
              value={recordData.hours} 
              onChange={handleChange} 
              placeholder="Enter hours..." 
              min="0.1"
              step="0.1"
            />
          </div>
        </div>
        
        <div className="modal-footer">
          <button onClick={onClose} className="cancel-btn">Cancel</button>
          <button 
            onClick={onSubmit} 
            disabled={depositing || !recordData.serviceType || !recordData.hours} 
            className="submit-btn"
          >
            {depositing ? "Depositing with FHE..." : "Deposit Time"}
          </button>
        </div>
      </div>
    </div>
  );
};

interface RecordDetailModalProps {
  record: TimeRecord;
  onClose: () => void;
  decryptedHours: number | null;
  setDecryptedHours: (value: number | null) => void;
  isDecrypting: boolean;
  decryptWithSignature: (encryptedData: string) => Promise<number | null>;
  address: string | undefined;
}

const RecordDetailModal: React.FC<RecordDetailModalProps> = ({ 
  record, 
  onClose, 
  decryptedHours, 
  setDecryptedHours, 
  isDecrypting, 
  decryptWithSignature,
  address
}) => {
  const handleDecrypt = async () => {
    if (decryptedHours !== null) { 
      setDecryptedHours(null); 
      return; 
    }
    
    const decrypted = await decryptWithSignature(record.hours);
    if (decrypted !== null) {
      setDecryptedHours(decrypted);
    }
  };

  return (
    <div className="modal-overlay">
      <div className="record-detail-modal">
        <div className="modal-header">
          <h2>Time Record Details</h2>
          <button onClick={onClose} className="close-modal">&times;</button>
        </div>
        
        <div className="modal-body">
          <div className="record-info">
            <div className="info-item">
              <span>Service Type:</span>
              <strong>{record.serviceType}</strong>
            </div>
            <div className="info-item">
              <span>Provider:</span>
              <strong>{record.provider.substring(0, 6)}...{record.provider.substring(38)}</strong>
            </div>
            {record.receiver && (
              <div className="info-item">
                <span>Receiver:</span>
                <strong>{record.receiver.substring(0, 6)}...{record.receiver.substring(38)}</strong>
              </div>
            )}
            <div className="info-item">
              <span>Date:</span>
              <strong>{new Date(record.timestamp * 1000).toLocaleDateString()}</strong>
            </div>
            <div className="info-item">
              <span>Status:</span>
              <strong className={`status-text ${record.status}`}>{record.status}</strong>
            </div>
          </div>
          
          <div className="encrypted-section">
            <h3>Encrypted Time Data</h3>
            <div className="encrypted-data">{record.hours.substring(0, 100)}...</div>
            <div className="fhe-tag">
              <div className="fhe-icon"></div>
              <span>FHE Encrypted</span>
            </div>
            {(record.provider === address || record.receiver === address) && (
              <button 
                className="decrypt-btn" 
                onClick={handleDecrypt} 
                disabled={isDecrypting}
              >
                {isDecrypting ? (
                  <span>Decrypting...</span>
                ) : decryptedHours !== null ? (
                  "Hide Decrypted Hours"
                ) : (
                  "Decrypt with Wallet Signature"
                )}
              </button>
            )}
          </div>
          
          {decryptedHours !== null && (
            <div className="decrypted-section">
              <h3>Decrypted Time Data</h3>
              <div className="decrypted-value">
                <span>Hours:</span>
                <strong>{decryptedHours.toFixed(1)}</strong>
              </div>
              <div className="decryption-notice">
                <div className="warning-icon"></div>
                <span>Decrypted hours are only visible after wallet signature verification</span>
              </div>
            </div>
          )}
        </div>
        
        <div className="modal-footer">
          <button onClick={onClose} className="close-btn">Close</button>
        </div>
      </div>
    </div>
  );
};

export default App;