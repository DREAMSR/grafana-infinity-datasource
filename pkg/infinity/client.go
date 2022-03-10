package infinity

import (
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io/ioutil"
	"net/http"
	"strings"
	"time"
)

type Client struct {
	Settings   InfinitySettings
	HttpClient *http.Client
}

func GetTLSConfigFromSettings(settings InfinitySettings) (*tls.Config, error) {
	tlsConfig := &tls.Config{
		InsecureSkipVerify: settings.InsecureSkipVerify,
		ServerName:         settings.ServerName,
	}
	if settings.TLSClientAuth {
		if settings.TLSClientCert == "" || settings.TLSClientKey == "" {
			return nil, errors.New("invalid Client cert or key")
		}
		cert, err := tls.X509KeyPair([]byte(settings.TLSClientCert), []byte(settings.TLSClientKey))
		if err != nil {
			return nil, err
		}
		tlsConfig.Certificates = []tls.Certificate{cert}
	}
	if settings.TLSAuthWithCACert && settings.TLSCACert != "" {
		caPool := x509.NewCertPool()
		ok := caPool.AppendCertsFromPEM([]byte(settings.TLSCACert))
		if !ok {
			return nil, errors.New("invalid TLS CA certificate")
		}
		tlsConfig.RootCAs = caPool
	}
	return tlsConfig, nil
}

func NewClient(settings InfinitySettings) (client *Client, err error) {
	tlsConfig, err := GetTLSConfigFromSettings(settings)
	if err != nil {
		return nil, err
	}
	transport := &http.Transport{
		Proxy:           http.ProxyFromEnvironment,
		TLSClientConfig: tlsConfig,
	}
	httpClient := &http.Client{
		Transport: transport,
		Timeout:   time.Second * time.Duration(settings.TimeoutInSeconds),
	}
	httpClient = ApplyOAuthClientCredentials(httpClient, settings)
	httpClient = ApplyOAuthJWT(httpClient, settings)
	return &Client{
		Settings:   settings,
		HttpClient: httpClient,
	}, err
}

func replaceSect(input string, settings InfinitySettings, includeSect bool) string {
	for key, value := range settings.SecureQueryFields {
		if includeSect {
			input = strings.ReplaceAll(input, fmt.Sprintf("${__qs.%s}", key), value)
		}
		if !includeSect {
			input = strings.ReplaceAll(input, fmt.Sprintf("${__qs.%s}", key), dummyHeader)
		}
	}
	return input
}

func (client *Client) req(url string, body *strings.Reader, settings InfinitySettings, isJSON bool, query Query, requestHeaders map[string]string) (obj interface{}, statusCode int, duration time.Duration, err error) {
	req, _ := GetRequest(settings, body, query, requestHeaders, true)
	startTime := time.Now()
	if !CanAllowURL(req.URL.String(), settings.AllowedHosts) {
		return nil, http.StatusUnauthorized, 0, errors.New("requested URL is not allowed. To allow this URL, update the datasource config URL -> Allowed Hosts section")
	}
	res, err := client.HttpClient.Do(req)
	duration = time.Since(startTime)
	if err != nil {
		return nil, res.StatusCode, duration, fmt.Errorf("error getting response from %s", url)
	}
	defer res.Body.Close()
	if res.StatusCode >= http.StatusBadRequest {
		return nil, res.StatusCode, duration, errors.New(res.Status)
	}
	bodyBytes, err := ioutil.ReadAll(res.Body)
	if err != nil {
		return nil, res.StatusCode, duration, err
	}
	if query.Type == QueryTypeJSON || query.Type == QueryTypeGraphQL {
		var out interface{}
		err := json.Unmarshal(bodyBytes, &out)
		return out, res.StatusCode, duration, err
	}
	if query.Type == QueryTypeUQL || query.Type == QueryTypeGROQ {
		contentType := res.Header.Get(contentTypeHeaderKey)
		if strings.Contains(strings.ToLower(contentType), contentTypeJSON) {
			var out interface{}
			err := json.Unmarshal(bodyBytes, &out)
			return out, res.StatusCode, duration, err
		}
	}
	return string(bodyBytes), res.StatusCode, duration, err
}

func (client *Client) GetResults(query Query, requestHeaders map[string]string) (o interface{}, statusCode int, duration time.Duration, err error) {
	isJSON := false
	if query.Type == QueryTypeJSON || query.Type == QueryTypeGraphQL {
		isJSON = true
	}
	switch strings.ToUpper(query.URLOptions.Method) {
	case http.MethodPost:
		body := GetQueryBody(query)
		return client.req(query.URL, body, client.Settings, isJSON, query, requestHeaders)
	default:
		return client.req(query.URL, nil, client.Settings, isJSON, query, requestHeaders)
	}
}

func CanAllowURL(url string, allowedHosts []string) bool {
	allow := false
	if len(allowedHosts) == 0 {
		return true
	}
	for _, host := range allowedHosts {
		if strings.HasPrefix(url, host) {
			return true
		}
	}
	return allow
}

func GetQueryBody(query Query) *strings.Reader {
	body := strings.NewReader(query.URLOptions.Data)
	if query.Type == QueryTypeGraphQL {
		jsonData := map[string]string{
			"query": query.URLOptions.Data,
		}
		jsonValue, _ := json.Marshal(jsonData)
		body = strings.NewReader(string(jsonValue))
	}
	return body
}
