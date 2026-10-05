# backup hook 會在改檔時產生 *_AI*.py 備份；pytest 預設會把 test_*_AI*.py 當成測試收進來，讓測試數虛增
collect_ignore_glob = ["*_AI*.py"]
