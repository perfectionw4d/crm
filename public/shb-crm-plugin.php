<?php
/**
 * Plugin Name: SHB CRM Integration
 * Plugin URI:  https://github.com/
 * Description: חיבור בין CRM לאתר WordPress — הצעות מחיר, הזמנות עבודה וחתימות דיגיטליות.
 * Version:     1.0.0
 * Author:      SHB CRM
 * Text Domain: shb-crm
 */

if ( ! defined( 'ABSPATH' ) ) exit;

// ─── Activation: create events table ─────────────────────────────────────────
register_activation_hook( __FILE__, 'shb_crm_activate' );
function shb_crm_activate() {
    global $wpdb;
    $table   = $wpdb->prefix . 'shb_crm_events';
    $charset = $wpdb->get_charset_collate();
    $sql = "CREATE TABLE IF NOT EXISTS {$table} (
        id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        event_type VARCHAR(64)     NOT NULL,
        data       LONGTEXT        NOT NULL,
        acked      TINYINT(1)      DEFAULT 0,
        created_at DATETIME        NOT NULL,
        PRIMARY KEY (id),
        KEY idx_acked (acked)
    ) {$charset};";
    require_once ABSPATH . 'wp-admin/includes/upgrade.php';
    dbDelta( $sql );
}

// ─── Admin Settings Page ──────────────────────────────────────────────────────
add_action( 'admin_menu', 'shb_crm_menu' );
function shb_crm_menu() {
    add_options_page(
        'CRM Integration',
        'CRM Integration',
        'manage_options',
        'shb-crm',
        'shb_crm_settings_page'
    );
}

function shb_crm_settings_page() {
    if ( isset( $_POST['shb_crm_key'] ) && check_admin_referer( 'shb_crm_save' ) ) {
        update_option( 'shb_crm_key', sanitize_text_field( $_POST['shb_crm_key'] ) );
        echo '<div class="updated"><p>✅ הגדרות נשמרו בהצלחה!</p></div>';
    }
    $key = get_option( 'shb_crm_key', '' );
    ?>
    <div class="wrap" dir="rtl">
        <h1>🔗 CRM Integration</h1>
        <p>תוסף זה מחבר את האתר שלך ל-CRM ומאפשר פרסום הצעות מחיר, הזמנות עבודה וחתימות דיגיטליות.</p>
        <hr/>
        <form method="post">
            <?php wp_nonce_field( 'shb_crm_save' ); ?>
            <table class="form-table">
                <tr>
                    <th scope="row"><label for="shb_crm_key">API Key</label></th>
                    <td>
                        <input
                            type="text"
                            name="shb_crm_key"
                            id="shb_crm_key"
                            value="<?php echo esc_attr( $key ); ?>"
                            class="regular-text"
                            placeholder="הזן כאן את ה-API Key שהגדרת ב-CRM"
                        />
                        <p class="description">
                            המפתח חייב להיות זהה למה שהגדרת בשדה "API Key" בהגדרות ה-CRM.
                            <?php if ( $key ) : ?>
                                <br/><strong style="color:green;">✅ מפתח מוגדר</strong>
                            <?php else : ?>
                                <br/><strong style="color:red;">⚠️ מפתח לא מוגדר — התוסף לא יעבוד ללא מפתח</strong>
                            <?php endif; ?>
                        </p>
                    </td>
                </tr>
            </table>
            <?php submit_button( 'שמור הגדרות' ); ?>
        </form>

        <?php if ( $key ) : ?>
        <hr/>
        <h2>בדיקת חיבור</h2>
        <p>אם ה-CRM מוגדר נכון, ניתן לבדוק את החיבור מתוך ה-CRM עצמו דרך <strong>הגדרות → WordPress → בדוק חיבור</strong>.</p>
        <p>ה-REST API זמין בכתובת: <code><?php echo esc_html( rest_url('shb-crm/v1/ping') ); ?></code></p>
        <?php endif; ?>
    </div>
    <?php
}

// ─── Authentication ───────────────────────────────────────────────────────────
function shb_crm_auth( $request ) {
    $key = get_option( 'shb_crm_key', '' );
    if ( empty( $key ) ) return false;
    return $request->get_header( 'X-CRM-Key' ) === $key;
}

// ─── REST API Routes ──────────────────────────────────────────────────────────
add_action( 'rest_api_init', 'shb_crm_register_routes' );
function shb_crm_register_routes() {
    $ns = 'shb-crm/v1';

    // Ping (CRM → WP)
    register_rest_route( $ns, '/ping', [
        'methods'             => 'GET',
        'callback'            => 'shb_crm_ping',
        'permission_callback' => 'shb_crm_auth',
    ]);

    // Create / update offer page (CRM → WP)
    register_rest_route( $ns, '/offers', [
        'methods'             => 'POST',
        'callback'            => 'shb_crm_create_offer',
        'permission_callback' => 'shb_crm_auth',
    ]);

    // Create / update order page (CRM → WP)
    register_rest_route( $ns, '/orders', [
        'methods'             => 'POST',
        'callback'            => 'shb_crm_create_order',
        'permission_callback' => 'shb_crm_auth',
    ]);

    // Get pending events (CRM pulls from WP)
    register_rest_route( $ns, '/events', [
        'methods'             => 'GET',
        'callback'            => 'shb_crm_get_events',
        'permission_callback' => 'shb_crm_auth',
    ]);

    // Acknowledge events (CRM → WP)
    register_rest_route( $ns, '/events/ack', [
        'methods'             => 'POST',
        'callback'            => 'shb_crm_ack_events',
        'permission_callback' => 'shb_crm_auth',
    ]);

    // Offer viewed — called from browser JS (no auth needed)
    register_rest_route( $ns, '/offer-viewed', [
        'methods'             => 'POST',
        'callback'            => 'shb_crm_offer_viewed',
        'permission_callback' => '__return_true',
    ]);

    // Order signed — called from browser JS (no auth needed)
    register_rest_route( $ns, '/sign-order', [
        'methods'             => 'POST',
        'callback'            => 'shb_crm_sign_order',
        'permission_callback' => '__return_true',
    ]);
}

// ─── Ping ─────────────────────────────────────────────────────────────────────
function shb_crm_ping( $request ) {
    return rest_ensure_response([
        'ok'      => true,
        'version' => '1.0.0',
        'site'    => get_bloginfo('url'),
    ]);
}

// ─── Create / Update Offer Page ───────────────────────────────────────────────
function shb_crm_create_offer( $request ) {
    $id           = sanitize_text_field( $request->get_param('id') ?? '' );
    $html         = $request->get_param('html') ?? '';
    $contact_id   = sanitize_text_field( $request->get_param('contact_id') ?? '' );
    $contact_name = sanitize_text_field( $request->get_param('contact_name') ?? '' );

    if ( ! $id ) {
        return new WP_Error( 'missing_id', 'Offer ID is required', [ 'status' => 400 ] );
    }

    // Look for existing page by meta
    $existing = shb_find_page_by_meta( '_shb_offer_id', $id );

    // Inject view-tracking script
    $tracking_script = sprintf(
        '<script>(function(){var k="shb_v_%s";if(sessionStorage.getItem(k))return;sessionStorage.setItem(k,"1");fetch("%s",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({offer_id:"%s",contact_id:"%s"})});})();</script>',
        esc_js( $id ),
        esc_js( rest_url('shb-crm/v1/offer-viewed') ),
        esc_js( $id ),
        esc_js( $contact_id )
    );
    $full_html = $html . $tracking_script;

    $page_data = [
        'post_title'     => 'הצעת מחיר מס׳ ' . $id,
        'post_content'   => $full_html,
        'post_status'    => 'publish',
        'post_type'      => 'page',
        'comment_status' => 'closed',
        'ping_status'    => 'closed',
    ];

    if ( $existing ) {
        $page_data['ID'] = $existing->ID;
        wp_update_post( $page_data );
        $page_id = $existing->ID;
    } else {
        $parent              = shb_get_or_create_parent( 'offers', 'הצעות מחיר' );
        $page_data['post_parent'] = $parent;
        $page_data['post_name']   = $id;
        $page_id = wp_insert_post( $page_data );
    }

    if ( is_wp_error( $page_id ) ) {
        return new WP_Error( 'insert_failed', $page_id->get_error_message(), [ 'status' => 500 ] );
    }

    update_post_meta( $page_id, '_shb_offer_id',     $id );
    update_post_meta( $page_id, '_shb_contact_id',   $contact_id );
    update_post_meta( $page_id, '_shb_contact_name', $contact_name );

    return rest_ensure_response([
        'ok'      => true,
        'url'     => get_permalink( $page_id ),
        'page_id' => $page_id,
    ]);
}

// ─── Create / Update Order Page ───────────────────────────────────────────────
function shb_crm_create_order( $request ) {
    $id           = sanitize_text_field( $request->get_param('id') ?? '' );
    $html         = $request->get_param('html') ?? '';
    $contact_id   = sanitize_text_field( $request->get_param('contact_id') ?? '' );
    $contact_name = sanitize_text_field( $request->get_param('contact_name') ?? '' );

    if ( ! $id ) {
        return new WP_Error( 'missing_id', 'Order ID is required', [ 'status' => 400 ] );
    }

    $existing  = shb_find_page_by_meta( '_shb_order_id', $id );
    $full_html = $html . shb_signature_html( $id, $contact_id );

    $page_data = [
        'post_title'     => 'הזמנת עבודה מס׳ ' . $id,
        'post_content'   => $full_html,
        'post_status'    => 'publish',
        'post_type'      => 'page',
        'comment_status' => 'closed',
        'ping_status'    => 'closed',
    ];

    if ( $existing ) {
        $page_data['ID'] = $existing->ID;
        wp_update_post( $page_data );
        $page_id = $existing->ID;
    } else {
        $parent              = shb_get_or_create_parent( 'orders', 'הזמנות עבודה' );
        $page_data['post_parent'] = $parent;
        $page_data['post_name']   = $id;
        $page_id = wp_insert_post( $page_data );
    }

    if ( is_wp_error( $page_id ) ) {
        return new WP_Error( 'insert_failed', $page_id->get_error_message(), [ 'status' => 500 ] );
    }

    update_post_meta( $page_id, '_shb_order_id',     $id );
    update_post_meta( $page_id, '_shb_contact_id',   $contact_id );
    update_post_meta( $page_id, '_shb_contact_name', $contact_name );

    return rest_ensure_response([
        'ok'      => true,
        'url'     => get_permalink( $page_id ),
        'page_id' => $page_id,
    ]);
}

// ─── Events ───────────────────────────────────────────────────────────────────
function shb_add_event( $type, $data ) {
    global $wpdb;
    $wpdb->insert(
        $wpdb->prefix . 'shb_crm_events',
        [
            'event_type' => $type,
            'data'       => wp_json_encode( $data ),
            'created_at' => current_time( 'mysql' ),
        ]
    );
}

function shb_crm_get_events( $request ) {
    global $wpdb;
    $table  = $wpdb->prefix . 'shb_crm_events';
    $events = $wpdb->get_results( "SELECT * FROM {$table} WHERE acked = 0 ORDER BY id ASC LIMIT 100" );
    // Decode data field for convenience
    foreach ( $events as &$ev ) {
        $ev->data = json_decode( $ev->data, true );
    }
    return rest_ensure_response( [ 'events' => $events ?: [] ] );
}

function shb_crm_ack_events( $request ) {
    global $wpdb;
    $ids   = array_map( 'intval', (array) ( $request->get_param('ids') ?? [] ) );
    $table = $wpdb->prefix . 'shb_crm_events';
    if ( ! empty( $ids ) ) {
        $placeholders = implode( ',', array_fill( 0, count( $ids ), '%d' ) );
        $wpdb->query( $wpdb->prepare( "UPDATE {$table} SET acked = 1 WHERE id IN ({$placeholders})", $ids ) );
    }
    return rest_ensure_response( [ 'ok' => true ] );
}

function shb_crm_offer_viewed( $request ) {
    $offer_id   = sanitize_text_field( $request->get_param('offer_id') ?? '' );
    $contact_id = sanitize_text_field( $request->get_param('contact_id') ?? '' );
    shb_add_event( 'offer_viewed', [ 'offer_id' => $offer_id, 'contact_id' => $contact_id ] );
    return rest_ensure_response( [ 'ok' => true ] );
}

function shb_crm_sign_order( $request ) {
    $order_id   = sanitize_text_field( $request->get_param('order_id') ?? '' );
    $contact_id = sanitize_text_field( $request->get_param('contact_id') ?? '' );
    $signature  = $request->get_param('signature') ?? '';
    $signed_at  = sanitize_text_field( $request->get_param('signed_at') ?? current_time( 'c' ) );
    shb_add_event( 'order_signed', [
        'order_id'   => $order_id,
        'contact_id' => $contact_id,
        'signature'  => $signature,
        'signed_at'  => $signed_at,
    ]);
    return rest_ensure_response( [ 'ok' => true ] );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function shb_find_page_by_meta( $meta_key, $meta_value ) {
    $pages = get_posts([
        'post_type'      => 'page',
        'meta_key'       => $meta_key,
        'meta_value'     => $meta_value,
        'numberposts'    => 1,
        'post_status'    => 'any',
    ]);
    return $pages ? $pages[0] : null;
}

function shb_get_or_create_parent( $slug, $title ) {
    $page = get_page_by_path( $slug );
    if ( $page ) return $page->ID;
    return wp_insert_post([
        'post_title'   => $title,
        'post_status'  => 'publish',
        'post_type'    => 'page',
        'post_name'    => $slug,
        'post_content' => '',
    ]);
}

// ─── Signature HTML ───────────────────────────────────────────────────────────
function shb_signature_html( $order_id, $contact_id ) {
    $sign_url = rest_url( 'shb-crm/v1/sign-order' );
    ob_start();
    ?>
<div id="shb-sig-wrap" style="max-width:640px;margin:40px auto;padding:28px;border:2px solid #6366f1;border-radius:14px;font-family:Arial,sans-serif;direction:rtl;text-align:right;background:#fafafa;">
  <h3 style="color:#1e1b4b;margin:0 0 10px;">✍️ חתימה דיגיטלית</h3>
  <p style="color:#6b7280;font-size:14px;margin:0 0 16px;">לאישור ההזמנה, חתמי בתיבה למטה ולחצי על "אשרי הזמנה".</p>
  <canvas id="shb-canvas" width="580" height="180"
    style="border:1.5px solid #d1d5db;border-radius:8px;background:white;cursor:crosshair;touch-action:none;display:block;width:100%;max-width:580px;margin-bottom:12px;"></canvas>
  <div style="margin-bottom:16px;">
    <button onclick="shbClear()" type="button"
      style="padding:8px 20px;background:#f3f4f6;border:none;border-radius:8px;cursor:pointer;font-size:14px;font-family:inherit;">
      🗑️ נקי
    </button>
  </div>
  <button onclick="shbSubmit()" id="shb-btn" type="button"
    style="width:100%;padding:14px;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:white;border:none;border-radius:10px;font-size:16px;font-weight:700;cursor:pointer;font-family:inherit;">
    ✅ אשרי הזמנה
  </button>
  <div id="shb-ok" style="margin-top:14px;font-size:15px;color:#10b981;font-weight:700;display:none;">🎉 ההזמנה אושרה! תודה רבה.</div>
  <div id="shb-err" style="margin-top:10px;font-size:13px;color:#dc2626;display:none;"></div>
</div>
<script>
(function() {
  var canvas = document.getElementById('shb-canvas');
  if (!canvas) return;
  var ctx = canvas.getContext('2d');
  var drawing = false, hasSig = false;
  ctx.strokeStyle = '#1e1b4b'; ctx.lineWidth = 2.5; ctx.lineCap = 'round'; ctx.lineJoin = 'round';

  function pos(e) {
    var r = canvas.getBoundingClientRect();
    var s = e.touches ? e.touches[0] : e;
    return { x:(s.clientX-r.left)*(canvas.width/r.width), y:(s.clientY-r.top)*(canvas.height/r.height) };
  }
  canvas.addEventListener('mousedown',  function(e){drawing=true;ctx.beginPath();var p=pos(e);ctx.moveTo(p.x,p.y);});
  canvas.addEventListener('mousemove',  function(e){if(!drawing)return;hasSig=true;var p=pos(e);ctx.lineTo(p.x,p.y);ctx.stroke();ctx.beginPath();ctx.moveTo(p.x,p.y);});
  canvas.addEventListener('mouseup',    function(){drawing=false;});
  canvas.addEventListener('mouseleave', function(){drawing=false;});
  canvas.addEventListener('touchstart', function(e){e.preventDefault();drawing=true;ctx.beginPath();var p=pos(e);ctx.moveTo(p.x,p.y);},{passive:false});
  canvas.addEventListener('touchmove',  function(e){e.preventDefault();if(!drawing)return;hasSig=true;var p=pos(e);ctx.lineTo(p.x,p.y);ctx.stroke();ctx.beginPath();ctx.moveTo(p.x,p.y);},{passive:false});
  canvas.addEventListener('touchend',   function(){drawing=false;});

  window.shbClear = function() { ctx.clearRect(0,0,canvas.width,canvas.height); hasSig=false; };
  window.shbSubmit = function() {
    if (!hasSig) { document.getElementById('shb-err').style.display='block'; document.getElementById('shb-err').textContent='נא לחתום לפני אישור'; return; }
    var btn = document.getElementById('shb-btn');
    btn.disabled=true; btn.textContent='שולח...';
    fetch('<?php echo esc_js( $sign_url ); ?>', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify({ order_id:'<?php echo esc_js($order_id); ?>', contact_id:'<?php echo esc_js($contact_id); ?>', signature:canvas.toDataURL('image/png'), signed_at:new Date().toISOString() })
    }).then(function(r){return r.json();}).then(function(){
      document.getElementById('shb-ok').style.display='block';
      document.getElementById('shb-sig-wrap').style.borderColor='#10b981';
      btn.style.background='#10b981'; btn.textContent='✅ ההזמנה אושרה';
    }).catch(function(e){ btn.disabled=false; btn.textContent='✅ אשרי הזמנה'; document.getElementById('shb-err').style.display='block'; document.getElementById('shb-err').textContent='שגיאה: '+e.message; });
  };
})();
</script>
    <?php
    return ob_get_clean();
}
